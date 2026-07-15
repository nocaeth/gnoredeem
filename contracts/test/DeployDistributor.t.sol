// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RedemptionDistributor} from "../src/RedemptionDistributor.sol";
import {RedemptionDeposit} from "../src/RedemptionDeposit.sol";
import {DeployDistributor} from "../script/DeployDistributor.s.sol";
// Both the deposit tokens and the payout token are now pulled via approve/transferFrom — deposit()
// pulls the stake in, and claim() pulls the payout from the Safe. Both mocks carry the full allowance
// surface; the payout mock (MockPayoutERC20) also keeps transfer() for the Safe-drain guard below.
import {MockERC20} from "./RedemptionDeposit.t.sol";
import {MockERC20 as MockPayoutERC20} from "./RedemptionDistributor.t.sol";

/// @notice Exercises the manifest -> on-chain deploy path used by DeployDistributor.s.sol.
///
///         The fixtures under test/fixtures/manifest-*.json are produced by the REAL off-chain builder
///         (offchain/build-merkle.ts), so the proofs are genuine. They are pinned to fixed addresses;
///         setUp() reproduces that world on-chain by deploying the real RedemptionDeposit + tokens and
///         `etch`ing them to those addresses (immutables travel with runtime code), then making real
///         deposits so `totalDeposited` is genuine contract state rather than a stub.
contract DeployDistributorTest is Test {
    using stdJson for string;

    // Addresses the fixtures were built against.
    address constant GNO = 0x1111111111111111111111111111111111111111;
    address constant OSGNO = 0x2222222222222222222222222222222222222222;
    address constant WXDAI = 0x3333333333333333333333333333333333333333;
    address constant SAFE = 0x4444444444444444444444444444444444444444;
    address constant DEPOSIT = 0x5555555555555555555555555555555555555555;

    address constant A1 = 0x00000000000000000000000000000000000000A1;
    address constant A2 = 0x00000000000000000000000000000000000000A2;
    address constant A3 = 0x00000000000000000000000000000000000000A3;

    uint256 constant DEADLINE = 1_000_000;
    uint256 constant RATE = 1.2e18;
    uint256 constant BASKET = 3300e18; // == sum of the fixture's leaves

    DeployDistributor script;

    function setUp() public {
        vm.warp(DEADLINE - 1000); // inside the deposit window
        vm.chainId(100); // the script refuses any chain but Gnosis

        vm.etch(GNO, address(new MockERC20("GNO")).code);
        vm.etch(OSGNO, address(new MockERC20("osGNO")).code);
        vm.etch(WXDAI, address(new MockPayoutERC20("WXDAI")).code);
        // Immutables (gno/osgno/safe/deadline/osgnoRate) are inlined in runtime code, so they survive
        // the etch — the contract at DEPOSIT is the real one, with the real frozen rate.
        vm.etch(DEPOSIT, address(new RedemptionDeposit(GNO, OSGNO, SAFE, DEADLINE, RATE)).code);

        // Real deposits: populates totalDeposited and forwards the stake to the Safe, exactly as in
        // production. The fixture's provenance.totalDeposited must match what these produce.
        _deposit(A1, GNO, 100e18);
        _deposit(A2, OSGNO, 100e18);
        _deposit(A3, GNO, 50e18);
        _deposit(A3, OSGNO, 50e18);

        // The Safe is funded with exactly the amounts to distribute.
        MockPayoutERC20(WXDAI).mint(SAFE, BASKET);

        script = new DeployDistributor();
    }

    function _deposit(address who, address token, uint256 amt) internal {
        MockERC20(token).mint(who, amt);
        vm.startPrank(who);
        MockERC20(token).approve(DEPOSIT, amt);
        RedemptionDeposit(DEPOSIT).deposit(token, amt);
        vm.stopPrank();
    }

    /// @dev The path is passed to deployFrom() explicitly rather than through MANIFEST_PATH: forge runs
    ///      test functions in parallel threads sharing one process env, so an env-passed path races.
    function _path(string memory name) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/", name, ".json");
    }

    // ─── happy path ──────────────────────────────────────────────────────────────

    function test_deploysFromManifest_andBindsToChain() public {
        RedemptionDistributor d = script.deployFrom(_path("manifest-full"), DEPOSIT);

        assertEq(d.merkleRoot(), 0xe2ea1f561c1a2dfc702d0ad3de48b328c36b18d3905d5c653f7a9d980c585de8, "root");
        address[] memory tokens = d.payoutTokens();
        assertEq(tokens.length, 1, "one payout leg");
        assertEq(tokens[0], WXDAI, "token identity + order");
        assertEq(d.payoutTotal(WXDAI), BASKET, "committed total == sum of leaves");

        // The whole point: the Safe can fund exactly what was committed, so activate() opens.
        vm.prank(SAFE);
        MockPayoutERC20(WXDAI).approve(address(d), BASKET);
        d.activate();
        assertTrue(d.activated(), "solvency gate opens on the committed totals");
    }

    /// @dev The manifest's leaves must be claimable against the deployed root — end to end, using the
    ///      proof the builder published, through the real claim() path.
    function test_publishedProof_claims() public {
        RedemptionDistributor d = script.deployFrom(_path("manifest-full"), DEPOSIT);
        vm.prank(SAFE);
        MockPayoutERC20(WXDAI).approve(address(d), BASKET);
        d.activate();

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/manifest-full.json"));
        bytes32[] memory proof = json.readBytes32Array(".manifest[1].proof");
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = vm.parseUint(json.readStringArray(".manifest[1].amounts")[0]);

        d.claim(A2, amounts, proof);
        assertEq(MockPayoutERC20(WXDAI).balanceOf(A2), 1200e18, "osGNO depositor paid at the frozen rate");
    }

    // ─── the guards ──────────────────────────────────────────────────────────────

    /// @dev The gate that stops a PREVIEW root reaching mainnet: cut at chain head, window still open.
    function test_revert_previewManifest() public {
        vm.expectRevert(bytes("cutoff block is not strictly after the deadline - preview/early manifest; refusing"));
        script.deployFrom(_path("manifest-preview"), DEPOSIT);
    }

    /// @dev The rate is a FIXED immutable. A manifest built with any other rate mis-weights every osGNO
    ///      depositor, so it must never deploy.
    function test_revert_rateDoesNotMatchFrozenImmutable() public {
        vm.expectRevert(bytes("osgnoRate != deposit contract's frozen immutable"));
        script.deployFrom(_path("manifest-badrate"), DEPOSIT);
    }

    /// @dev A tampered leaf whose totals were adjusted to keep conservation intact — only re-deriving
    ///      the root from the leaves catches this. Proves the root is checked, not trusted.
    function test_revert_tamperedLeaf() public {
        vm.expectRevert(bytes("leaf/proof does not verify against manifest root"));
        script.deployFrom(_path("manifest-tamperedleaf"), DEPOSIT);
    }

    /// @dev Committing more than the leaves sum to would leave activate() permanently unfundable.
    function test_revert_overCommittedTotal() public {
        vm.expectRevert(bytes("sum of leaves != committed payoutTotal"));
        script.deployFrom(_path("manifest-overcommit"), DEPOSIT);
    }

    /// @dev If the Safe cannot cover a leg, the deploy would commit to a basket that can never be
    ///      funded — every claim bricked. Caught before the immutable totals are written.
    function test_revert_safeCannotFundBasket() public {
        // Drain the Safe below the committed total.
        vm.prank(SAFE);
        MockPayoutERC20(WXDAI).transfer(address(0xdead), 1);

        vm.expectRevert(bytes("Safe balance < committed payoutTotal - unfundable"));
        script.deployFrom(_path("manifest-full"), DEPOSIT);
    }

    function test_revert_wrongChain() public {
        vm.chainId(1);
        vm.expectRevert(bytes("not Gnosis Chain (expected 100)"));
        script.deployFrom(_path("manifest-full"), DEPOSIT);
    }

    // ─── H1: a production manifest (no treasurySafe) deploys; safe comes from chain ────────

    /// @dev The real fetch-deposits manifest carries no `treasurySafe` field — the funding Safe is the
    ///      deposit contract's immutable. Before H1 this manifest could not deploy (the script required
    ///      treasurySafe); now it deploys and the distributor's safe is sourced from the deposit contract.
    function test_h1_productionManifest_noTreasurySafe_deploys() public {
        RedemptionDistributor d = script.deployFrom(_path("manifest-production"), DEPOSIT);
        assertEq(d.safe(), SAFE, "safe sourced from the deposit contract's immutable, not the manifest");
        assertEq(d.payoutTotal(WXDAI), BASKET, "committed total == sum of leaves");
    }

    // ─── H2: a manifest listing more leaves than holderCount is refused ────────────────────

    /// @dev holderCount understates the listed leaves (2 vs 3), and payoutTotals sums only the first two
    ///      — so conservation passes, yet the unsummed third leaf is fully claimable against the same
    ///      root and would drain the Safe from under honest late claimers. The bound check catches it.
    function test_h2_manifestListsMoreLeavesThanHolderCount_reverts() public {
        vm.expectRevert(bytes("manifest lists more leaves than holderCount"));
        script.deployFrom(_path("manifest-undercount"), DEPOSIT);
    }

    // ─── M1: the manifest's deposit contract must match the operator's expected pin ────────

    /// @dev provenance.depositContract is operator-supplied; every downstream check trusts it as the
    ///      authority. A wrong (attacker-chosen) deposit contract must fail the deploy before any dep.*
    ///      read, not silently re-anchor the rate/total/safe checks.
    function test_m1_wrongExpectedDeposit_reverts() public {
        vm.expectRevert(bytes("provenance.depositContract != expected - refusing"));
        script.deployFrom(_path("manifest-full"), address(0xBAD));
    }

}
