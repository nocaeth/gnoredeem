// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RedemptionDeposit} from "../src/RedemptionDeposit.sol";
import {RedemptionDistributor} from "../src/RedemptionDistributor.sol";
import {MockERC20} from "./RedemptionDistributor.t.sol";

/// @notice PoCs for findings surfaced during the Plamen audit. Each test is self-contained
///         and demonstrates the EXACT harm claimed by the finding (not just the mechanism).
contract PlamenFindingsPoC is Test {
    MockERC20 internal A;
    MockERC20 internal B;

    address internal h0 = address(0xA0);

    bytes32 internal root;
    uint256[] internal amtH0;
    bytes32[] internal proofH0;

    function setUp() public {
        A = new MockERC20("A");
        B = new MockERC20("B");

        amtH0.push(100);
        amtH0.push(10);

        // Single-leaf tree: root = leaf (no proof needed beyond empty).
        bytes32 leaf = _leaf(h0, amtH0);
        bytes32 fakeSibling = keccak256(abi.encodePacked(leaf, bytes32(0)));
        root = _pair(leaf, fakeSibling);
        proofH0.push(fakeSibling);
    }

    function _leaf(address acct, uint256[] memory amts) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(acct, amts))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _deploy(address[] memory tk, uint256[] memory tot, address safe_)
        internal
        returns (RedemptionDistributor)
    {
        return new RedemptionDistributor(root, tk, tot, safe_);
    }

    // ── C1: Leaf omits chainid/distributor binding ──────────────────────────
    // HARM: an attacker who reuses the published root on a SECOND funded distributor
    //       can drain it using proofs copied from the first. Demonstrates a holder
    //       claiming on distributor V1 then claiming the SAME basket on distributor V2.
    function test_C1_crossInstanceLeafReplay() public {
        address[] memory tk = new address[](2);
        tk[0] = address(A);
        tk[1] = address(B);
        uint256[] memory tot = new uint256[](2);
        tot[0] = 100;
        tot[1] = 10;

        address safe1 = address(0x51);
        address safe2 = address(0x52);

        // V1: the legitimate distributor, funded from its own Safe.
        RedemptionDistributor v1 = _deploy(tk, tot, safe1);
        _fundSafe(safe1, address(v1), 100, 10);
        v1.activate();
        v1.claim(h0, amtH0, proofH0);
        assertEq(A.balanceOf(h0), 100, "V1 holder paid");

        // V2: a second distributor deployed with the SAME root (intentional migration,
        // social-engineering, or operator error). Independently funded from a second Safe.
        RedemptionDistributor v2 = _deploy(tk, tot, safe2);
        _fundSafe(safe2, address(v2), 100, 10);
        v2.activate();

        // HARM: the same proof drains V2  -  h0 claims twice.
        v2.claim(h0, amtH0, proofH0);
        assertEq(A.balanceOf(h0), 200, "HARM: double-claimed across instances");
        assertEq(B.balanceOf(h0), 20, "HARM: double-claimed across instances");
    }

    // Safe custody: mint the A/B basket to `safe_` and approve `dist` to pull it via transferFrom.
    function _fundSafe(address safe_, address dist, uint256 aAmt, uint256 bAmt) internal {
        A.mint(safe_, aAmt);
        B.mint(safe_, bAmt);
        vm.startPrank(safe_);
        A.approve(dist, aAmt);
        B.approve(dist, bAmt);
        vm.stopPrank();
    }

    // ── C3: Atomic all-or-nothing claim bricked by one reverting leg ────────
    // HARM: a holder whose basket contains a blacklisted/paused token receives NONE
    //       of their basket  -  not even the working legs. They are permanently locked
    //       out because hasClaimed is reverted together with the failing transfer.
    function test_C3_atomicClaimBrickedByOneRevertingLeg() public {
        // Replace B with a token that reverts on transfer to h0 (issuer blocklist).
        BlocklistERC20 bl = new BlocklistERC20();
        bl.setBlocked(h0, true);

        address[] memory tk = new address[](2);
        tk[0] = address(A);
        tk[1] = address(bl);
        uint256[] memory tot = new uint256[](2);
        tot[0] = 100;
        tot[1] = 10;

        address safe_ = address(0x53);
        RedemptionDistributor d = _deploy(tk, tot, safe_);
        // Safe holds and approves the full basket, so activate() passes; the brick is at claim time.
        A.mint(safe_, 100);
        bl.mint(safe_, 10);
        vm.startPrank(safe_);
        A.approve(address(d), 100);
        bl.approve(address(d), 10);
        vm.stopPrank();
        d.activate();

        // HARM: claim reverts on the blocklisted leg (the pull to h0 is blocked); A is NOT delivered
        //       even though A's leg would succeed on its own.
        vm.expectRevert();
        d.claim(h0, amtH0, proofH0);

        assertEq(A.balanceOf(h0), 0, "HARM: working leg withheld");
        assertFalse(d.hasClaimed(h0), "claim not finalized");

        // Retry still reverts  -  permanent lock.
        vm.expectRevert();
        d.claim(h0, amtH0, proofH0);
    }

    // ── D1: Constructor permits gno_ == osgno_ ──────────────────────────────
    // HARM: demonstrate that the contract accepts the same address for both token
    //       slots. No fund loss in this synthetic mock, but on Gnosis this would
    //       mean deposits for "GNO" and "osGNO" collapse to a single accounting
    //       entry  -  the off-chain builder cannot distinguish them. Pre-deploy
    //       constructor is the only place to catch this; nothing on-chain does.
    function test_D1_constructorAcceptsGnoEqOsgno() public {
        MockERC20 single = new MockERC20("GNO");
        // Both token slots point at the same address; constructor accepts it.
        RedemptionDeposit dep = new RedemptionDeposit(
            address(single),
            address(single), // <-- same as gno_
            address(0xBEEF),
            block.timestamp + 1 days,
            1e18
        );
        assertEq(address(dep.gno()), address(dep.osgno()), "constructor accepted gno_ == osgno_");
    }

    // ── D2: Constructor permits safe_ == gno_ (or osgno_) ───────────────────
    // HARM: a deposit sends tokens to the token contract itself; whether they are
    //       recoverable depends entirely on the token's admin (GNO is an upgradeable
    //       proxy). The contract never custodies, so there is no internal recovery.
    function test_D2_constructorAcceptsSafeEqToken() public {
        MockERC20 gno = new MockERC20("GNO");
        RedemptionDeposit dep = new RedemptionDeposit(
            address(gno),
            address(0xCAFE),
            address(gno), // <-- safe == gno
            block.timestamp + 1 days,
            1e18
        );
        assertEq(address(dep.safe()), address(gno), "constructor accepted safe_ == gno_");
    }
}

contract BlocklistERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function setBlocked(address a, bool b) external { blocked[a] = b; }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(!blocked[msg.sender] && !blocked[to], "blocked");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    // claim() pulls via transferFrom; a blocked recipient (or sender) bricks the leg — the issuer
    // blocklist applies regardless of who submits the pull.
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(!blocked[from] && !blocked[to], "blocked");
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}
