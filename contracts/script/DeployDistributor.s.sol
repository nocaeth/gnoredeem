// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RedemptionDistributor} from "../src/RedemptionDistributor.sol";

/// @title  Deploy RedemptionDistributor from the published Merkle manifest (Gnosis Chain).
/// @notice Reads root / payoutTokens / payoutTotals DIRECTLY from the builder output (offchain/out.json)
///         — no hand transcription — and re-asserts the deployed state matches that manifest, in order.
///         Note this binds the contract to the MANIFEST, not to the GIP-151-approved basket: both sides
///         of every assert come from the same out.json. The token/total set is operator-supplied
///         governance data with no on-chain source of truth, so the run echoes each token+symbol+total
///         with a VERIFY tag — check them against the published GIP-151 basket and the Safe's holdings
///         before funding (same trust class as `safe` in Deploy.s.sol).
/// @dev    Usage:
///           MANIFEST_PATH=../offchain/out.json \
///           forge script script/DeployDistributor.s.sol:DeployDistributor --rpc-url $RPC_GNOSIS --broadcast --account <acct>
///         Then fund the distributor with EXACTLY payoutTotals and call activate().
contract DeployDistributor is Script {
    using stdJson for string;

    function run() external returns (RedemptionDistributor dist) {
        require(block.chainid == 100, "not Gnosis Chain (expected 100)");

        // No default: a fallback to the checked-in sample (offchain/out.json) would let an operator
        // deploy the fixture root to mainnet. MANIFEST_PATH must be passed explicitly.
        string memory path = vm.envOr("MANIFEST_PATH", string(""));
        require(bytes(path).length > 0, "MANIFEST_PATH unset - pass the build-merkle output explicitly");
        string memory json = vm.readFile(path);

        bytes32 root = json.readBytes32(".root");
        address[] memory tokens = json.readAddressArray(".payoutTokens");
        string[] memory totalStrs = json.readStringArray(".payoutTotals"); // strings: full uint256 precision
        string[] memory symbols = json.readStringArray(".payoutSymbols");
        require(root != bytes32(0), "zero root in manifest");
        require(tokens.length == totalStrs.length, "tokens/totals length mismatch");
        require(tokens.length == symbols.length, "tokens/symbols length mismatch");

        uint256[] memory totals = new uint256[](totalStrs.length);
        for (uint256 i = 0; i < totalStrs.length; i++) {
            totals[i] = vm.parseUint(totalStrs[i]);
        }

        console2.log("chainid ", block.chainid);
        console2.log("manifest", path);
        console2.logBytes32(root);
        // VERIFY each leg against the published GIP-151 basket + the Safe's holdings before funding.
        for (uint256 i = 0; i < tokens.length; i++) {
            console2.log("  symbol (VERIFY!)", symbols[i]);
            console2.log("  token ", tokens[i]);
            console2.log("  total ", totals[i]);
        }

        vm.startBroadcast();
        dist = new RedemptionDistributor(root, tokens, totals);
        vm.stopBroadcast();

        console2.log("RedemptionDistributor", address(dist));
        _assertMatchesManifest(dist, root, tokens, totals);
        console2.log("post-deploy manifest asserts: PASS");
        console2.log("next: fund with exactly payoutTotals, then call activate()");
    }

    function _assertMatchesManifest(
        RedemptionDistributor dist,
        bytes32 root,
        address[] memory tokens,
        uint256[] memory totals
    ) internal view {
        require(dist.merkleRoot() == root, "root mismatch");
        address[] memory onchain = dist.payoutTokens();
        require(onchain.length == tokens.length, "token count mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            require(onchain[i] == tokens[i], "token order/identity mismatch");
            require(dist.payoutTotal(tokens[i]) == totals[i], "total mismatch");
        }
    }
}
