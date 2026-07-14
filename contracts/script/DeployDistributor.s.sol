// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RedemptionDistributor} from "../src/RedemptionDistributor.sol";
import {RedemptionDeposit} from "../src/RedemptionDeposit.sol";

/// @title  Deploy RedemptionDistributor from the published Merkle manifest (Gnosis Chain).
/// @notice Reads root / payoutTokens / payoutTotals DIRECTLY from the builder output — no hand
///         transcription — and, before broadcasting, re-derives the root from the manifest's own
///         leaves and re-binds every governance-supplied number to on-chain state.
///
///         The manifest is operator-supplied. Rather than trust it, this script checks it against the
///         only authorities that exist: the deployed RedemptionDeposit (which froze `osgnoRate`,
///         `deadline`, `gno`, `osgno` and `safe` as immutables at ITS deploy, and whose
///         `totalDeposited` mappings are the canonical deposit record) and the redemption Safe's
///         actual balances. Every check below fails the deploy rather than warning.
///
///         What is verified:
///           1. FROZEN RATE   — the manifest's osgnoRate equals the deposit contract's immutable. The
///                              tree weights holders as rawGno + rawOsgno * osgnoRate / 1e18, so a
///                              manifest built with any other rate mis-weights every osGNO depositor.
///           2. DEPOSIT SET   — the manifest's totalDeposited matches the contract's mappings, and
///                              gno/osgno/safe match its immutables.
///           3. WINDOW CLOSED — the cutoff block is strictly after the deadline AND finalized. This is
///                              what refuses a PREVIEW root: previews are built at chain head with the
///                              deposit window still open.
///           4. ROOT          — every holder's leaf is rebuilt EXACTLY as claim() does and verified
///                              against the manifest root, so the root is proven to be the root of this
///                              exact claim set rather than copied from JSON.
///           5. CONSERVATION  — the leaves sum to payoutTotals per token. Over-commit makes activate()
///                              unfundable; under-commit strands the last claimers.
///           6. SOLVENCY      — the Safe holds >= every committed total, so funding can succeed.
///
/// @dev    Usage:
///           MANIFEST_PATH=../offchain/merkle-out.json \
///           forge script script/DeployDistributor.s.sol:DeployDistributor --rpc-url $RPC_GNOSIS --broadcast --account <acct>
///         Then transfer EXACTLY payoutTotals from the Safe (the script prints them) and call activate().
contract DeployDistributor is Script {
    using stdJson for string;

    struct Manifest {
        bytes32 root;
        address[] tokens;
        string[] symbols;
        uint256[] totals;
        uint256 holderCount;
        address depositContract;
        address safe;
    }

    function run() external returns (RedemptionDistributor) {
        // No default: a fallback to a checked-in sample would let an operator deploy a fixture root to
        // mainnet. MANIFEST_PATH must be passed explicitly.
        string memory path = vm.envOr("MANIFEST_PATH", string(""));
        require(bytes(path).length > 0, "MANIFEST_PATH unset - pass the build-merkle output explicitly");
        return deployFrom(path);
    }

    /// @notice The deploy, with the manifest path passed explicitly. `run()` is the CLI wrapper.
    /// @dev    Separate from run() so tests can drive it without vm.setEnv — forge runs test functions
    ///         in parallel threads that share process env, so an env-passed path races between tests.
    function deployFrom(string memory path) public returns (RedemptionDistributor dist) {
        require(block.chainid == 100, "not Gnosis Chain (expected 100)");
        string memory json = vm.readFile(path);

        Manifest memory m = _readManifest(json);

        console2.log("chainid ", block.chainid);
        console2.log("manifest", path);
        console2.log("deposit ", m.depositContract);
        console2.log("safe    ", m.safe);
        console2.logBytes32(m.root);

        // Bind the manifest to chain BEFORE deploying. Order matters: the frozen rate and the deposit
        // set decide what the leaves SHOULD be; the root check then proves the leaves are what shipped.
        _verifyAgainstDepositContract(json, m);
        _verifyWindowClosed(json, m);
        _verifyRootAndConservation(json, m);
        _verifySolvency(m);

        vm.startBroadcast();
        dist = new RedemptionDistributor(m.root, m.tokens, m.totals);
        vm.stopBroadcast();

        console2.log("RedemptionDistributor", address(dist));
        _assertMatchesManifest(dist, m);

        console2.log("");
        console2.log("all pre-deploy checks: PASS");
        console2.log("fund by transferring EXACTLY these amounts from the Safe to the distributor:");
        for (uint256 i = 0; i < m.tokens.length; i++) {
            console2.log("  symbol", m.symbols[i]);
            console2.log("  token ", m.tokens[i]);
            console2.log("  amount", m.totals[i]);
        }
        console2.log("then call activate()");
    }

    // ─── manifest parsing ────────────────────────────────────────────────────────

    function _readManifest(string memory json) internal view returns (Manifest memory m) {
        m.root = json.readBytes32(".root");
        m.tokens = json.readAddressArray(".payoutTokens");
        m.symbols = json.readStringArray(".payoutSymbols");
        m.totals = _parseUintArray(json.readStringArray(".payoutTotals")); // strings: full uint256 precision
        m.holderCount = json.readUint(".holderCount");

        require(m.root != bytes32(0), "zero root in manifest");
        require(m.tokens.length == m.totals.length, "tokens/totals length mismatch");
        require(m.tokens.length == m.symbols.length, "tokens/symbols length mismatch");
        require(m.holderCount > 0, "manifest has no holders");

        // build-merkle only emits `provenance` when the config carried on-chain meta (i.e. it came from
        // fetch-deposits, not a hand-assembled JSON). Without it there is nothing to bind to chain, so
        // refuse — an unbindable manifest is exactly the hand-typed basket this script exists to stop.
        require(vm.keyExistsJson(json, ".provenance"), "manifest has no provenance - not built from chain; refusing");
        m.depositContract = json.readAddress(".provenance.depositContract");
        m.safe = json.readAddress(".provenance.treasurySafe");
    }

    // ─── 1 + 2: frozen rate, deposit set, token identities ───────────────────────

    function _verifyAgainstDepositContract(string memory json, Manifest memory m) internal view {
        RedemptionDeposit dep = RedemptionDeposit(m.depositContract);

        // The rate is FIXED — an immutable frozen when RedemptionDeposit was deployed. It is the single
        // number that converts osGNO deposits into tree weight, so a manifest built with a stale or
        // hand-edited rate mis-weights every osGNO depositor. The on-chain immutable is the authority.
        require(
            vm.parseUint(json.readString(".provenance.osgnoRate")) == dep.osgnoRate(),
            "osgnoRate != deposit contract's frozen immutable"
        );

        // The deposit tokens the tree was built over must be the ones the contract actually accepts.
        address gno = address(dep.gno());
        address osgno = address(dep.osgno());
        require(json.readAddress(".provenance.gno") == gno, "gno != deposit contract immutable");
        require(json.readAddress(".provenance.osgno") == osgno, "osgno != deposit contract immutable");

        // The canonical deposit record. build-merkle reconciled the config's per-holder sums against
        // these same totals; re-checking here binds the DEPLOYED root to chain state, so a manifest
        // built from a truncated or stale event scan cannot reach mainnet.
        require(
            vm.parseUint(json.readString(".provenance.totalDeposited.gno")) == dep.totalDeposited(gno),
            "totalDeposited(GNO) != on-chain"
        );
        require(
            vm.parseUint(json.readString(".provenance.totalDeposited.osgno")) == dep.totalDeposited(osgno),
            "totalDeposited(osGNO) != on-chain"
        );

        // Deposits are forwarded to `safe`, and the payout basket is drawn from that same Safe's
        // balances — so the funding source is an immutable of the deposit contract, not a JSON field.
        require(m.safe == dep.safe(), "provenance.treasurySafe != deposit contract's safe immutable");

        // A payout token can never be GNO/osGNO: those sit in the Safe only because deposits are
        // forwarded there, so paying them out would hand depositors back their own stake.
        for (uint256 i = 0; i < m.tokens.length; i++) {
            require(m.tokens[i] != gno && m.tokens[i] != osgno, "payout token is a deposit token");
        }
    }

    // ─── 3: the window was closed and final at the cutoff ────────────────────────

    function _verifyWindowClosed(string memory json, Manifest memory m) internal view {
        uint256 deadline = vm.parseUint(json.readString(".provenance.deadline"));
        uint256 cutoffTs = vm.parseUint(json.readString(".provenance.toBlockTimestamp"));
        uint256 toBlock = vm.parseUint(json.readString(".provenance.toBlock"));

        require(RedemptionDeposit(m.depositContract).deadline() == deadline, "deadline != deposit contract immutable");

        // deposit() accepts while block.timestamp <= deadline, so a cutoff at or before the deadline can
        // miss still-valid later deposits and the root would omit them — permanently, since there is no
        // second distribution. This is also the gate that refuses a PREVIEW manifest: previews are cut
        // at chain head while the window is still open.
        require(cutoffTs > deadline, "cutoff block is not strictly after the deadline - preview/early manifest; refusing");

        // Reorg safety: the deposit set must have been read from a finalized block. fetch-deposits.ts
        // records the finalized head it checked against; preview-deposits.ts does not emit this key at
        // all, so a preview manifest cannot pass even after the deadline has elapsed.
        require(
            vm.keyExistsJson(json, ".provenance.finalizedHead"),
            "no finalizedHead in provenance - not a finalized fetch; refusing"
        );
        require(
            toBlock <= vm.parseUint(json.readString(".provenance.finalizedHead")),
            "cutoff block is past the finalized head it was checked against"
        );
    }

    // ─── 4 + 5: rebuild the root from the leaves; leaves must sum to the totals ───

    function _verifyRootAndConservation(string memory json, Manifest memory m) internal view {
        uint256 n = m.tokens.length;
        uint256[] memory summed = new uint256[](n);
        address prevHolder = address(0);

        for (uint256 h = 0; h < m.holderCount; h++) {
            string memory base = string.concat(".manifest[", vm.toString(h), "]");
            address holder = json.readAddress(string.concat(base, ".holder"));
            uint256[] memory amounts = _parseUintArray(json.readStringArray(string.concat(base, ".amounts")));
            bytes32[] memory proof = json.readBytes32Array(string.concat(base, ".proof"));

            require(amounts.length == n, "leaf amounts length != payoutTokens length");

            // Strictly ascending holders: build-merkle sorts them, and a duplicate account would mean
            // two leaves for one holder — hasClaimed[] lets only the first be claimed, so the second's
            // funds would sit in the distributor forever (there is no sweep).
            require(holder > prevHolder, "manifest holders not strictly ascending (duplicate or unsorted)");
            prevHolder = holder;

            // The leaf is built EXACTLY as RedemptionDistributor.claim() builds it. If this verifies for
            // every holder, the committed root is the root of precisely this claim set — the root is
            // checked, not trusted, and every published claim is known to be claimable.
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(holder, amounts))));
            require(MerkleProof.verify(proof, m.root, leaf), "leaf/proof does not verify against manifest root");

            for (uint256 i = 0; i < n; i++) {
                summed[i] += amounts[i];
            }
        }

        // Conservation: what the contract commits to pay must equal what the tree actually pays. If
        // totals > sum(leaves), the Safe must over-fund or activate() reverts; if totals < sum(leaves),
        // the last claimers find the contract drained and their claim reverts forever.
        for (uint256 i = 0; i < n; i++) {
            require(summed[i] == m.totals[i], "sum of leaves != committed payoutTotal");
        }
        console2.log("verified leaves (all proofs valid, totals conserved):", m.holderCount);
    }

    // ─── 6: the Safe can actually fund what we are about to commit to ────────────

    function _verifySolvency(Manifest memory m) internal view {
        for (uint256 i = 0; i < m.tokens.length; i++) {
            // activate() reverts until the distributor holds >= every committed total. If the Safe
            // cannot cover a leg, the deploy commits to a basket that can never be funded and EVERY
            // claim is bricked — catch it here, before the immutable totals are written.
            require(IERC20(m.tokens[i]).balanceOf(m.safe) >= m.totals[i], "Safe balance < committed payoutTotal - unfundable");
        }
    }

    // ─── post-deploy: the immutables really are what we committed ────────────────

    function _assertMatchesManifest(RedemptionDistributor dist, Manifest memory m) internal view {
        require(dist.merkleRoot() == m.root, "root mismatch");
        address[] memory onchain = dist.payoutTokens();
        require(onchain.length == m.tokens.length, "token count mismatch");
        for (uint256 i = 0; i < m.tokens.length; i++) {
            // Order is load-bearing: leaf amounts are positional, so a transposed tokens[] would pay
            // every holder the right numbers against the wrong assets.
            require(onchain[i] == m.tokens[i], "token order/identity mismatch");
            require(dist.payoutTotal(m.tokens[i]) == m.totals[i], "total mismatch");
        }
        console2.log("post-deploy manifest asserts: PASS");
    }

    function _parseUintArray(string[] memory strs) internal pure returns (uint256[] memory out) {
        out = new uint256[](strs.length);
        for (uint256 i = 0; i < strs.length; i++) {
            out[i] = vm.parseUint(strs[i]);
        }
    }
}
