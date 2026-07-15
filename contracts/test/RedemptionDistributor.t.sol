// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RedemptionDistributor} from "../src/RedemptionDistributor.sol";

contract MockERC20 {
    string public symbol;
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory s) {
        symbol = s;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt; // reverts (underflow) if under-funded
        balanceOf[to] += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt; // reverts (underflow) if under-approved
        balanceOf[from] -= amt; // reverts (underflow) if under-funded
        balanceOf[to] += amt;
        return true;
    }
}

contract RedemptionDistributorTest is Test {
    MockERC20 internal A;
    MockERC20 internal B;

    address internal safe = address(0x5AFE);
    address internal h0 = address(0xA0);
    address internal h1 = address(0xA1);
    address internal h2 = address(0xA2);
    address internal h3 = address(0xA3);

    bytes32 internal root;
    mapping(address => uint256[]) internal amtOf;
    mapping(address => bytes32[]) internal proofOf;

    // Totals: A = 100+200+300+400 = 1000 ; B = 10+20+30+40 = 100.
    uint256 internal constant TOTAL_A = 1000;
    uint256 internal constant TOTAL_B = 100;

    function setUp() public {
        A = new MockERC20("A");
        B = new MockERC20("B");

        _set(h0, 100, 10);
        _set(h1, 200, 20);
        _set(h2, 300, 30);
        _set(h3, 400, 40);

        // Balanced 4-leaf tree, OZ-compatible (double-hashed leaves, sorted-pair internal nodes).
        bytes32 l0 = _leaf(h0, amtOf[h0]);
        bytes32 l1 = _leaf(h1, amtOf[h1]);
        bytes32 l2 = _leaf(h2, amtOf[h2]);
        bytes32 l3 = _leaf(h3, amtOf[h3]);
        bytes32 i0 = _pair(l0, l1);
        bytes32 i1 = _pair(l2, l3);
        root = _pair(i0, i1);

        proofOf[h0].push(l1);
        proofOf[h0].push(i1);
        proofOf[h1].push(l0);
        proofOf[h1].push(i1);
        proofOf[h2].push(l3);
        proofOf[h2].push(i0);
        proofOf[h3].push(l2);
        proofOf[h3].push(i0);
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    function _set(address acct, uint256 a, uint256 b) internal {
        amtOf[acct].push(a);
        amtOf[acct].push(b);
    }

    function _mem(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _leaf(address acct, uint256[] memory amts) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(acct, amts))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _deploy() internal returns (RedemptionDistributor d) {
        address[] memory tk = new address[](2);
        tk[0] = address(A);
        tk[1] = address(B);
        uint256[] memory tot = new uint256[](2);
        tot[0] = TOTAL_A;
        tot[1] = TOTAL_B;
        d = new RedemptionDistributor(root, tk, tot, safe);
    }

    // Safe custody: mint the basket to the Safe and approve the distributor to pull it. The distributor
    // never holds the tokens; claim() pulls Safe -> holder via transferFrom.
    function _fund(RedemptionDistributor d) internal {
        A.mint(safe, TOTAL_A);
        B.mint(safe, TOTAL_B);
        vm.startPrank(safe);
        A.approve(address(d), TOTAL_A);
        B.approve(address(d), TOTAL_B);
        vm.stopPrank();
    }

    function _ready() internal returns (RedemptionDistributor d) {
        d = _deploy();
        _fund(d);
        d.activate();
    }

    // ── happy path ───────────────────────────────────────────────────────────
    function test_claim_deliversFullBasketInOneCall() public {
        RedemptionDistributor d = _ready();
        d.claim(h0, amtOf[h0], proofOf[h0]);
        assertEq(A.balanceOf(h0), 100, "A to h0");
        assertEq(B.balanceOf(h0), 10, "B to h0");
        assertTrue(d.hasClaimed(h0));
    }

    function test_allHoldersClaim_drainsExactly() public {
        RedemptionDistributor d = _ready();
        d.claim(h0, amtOf[h0], proofOf[h0]);
        d.claim(h1, amtOf[h1], proofOf[h1]);
        d.claim(h2, amtOf[h2], proofOf[h2]);
        d.claim(h3, amtOf[h3], proofOf[h3]);
        // Safe custody: the Safe drains to exactly zero; the distributor never held anything.
        assertEq(A.balanceOf(safe), 0, "A drained from Safe");
        assertEq(B.balanceOf(safe), 0, "B drained from Safe");
        assertEq(A.balanceOf(address(d)), 0, "distributor never custodies A");
        assertEq(B.balanceOf(address(d)), 0, "distributor never custodies B");
        assertEq(A.balanceOf(h3), 400);
        assertEq(B.balanceOf(h3), 40);
    }

    function test_claim_byRelayer_paysAccountNotSender() public {
        RedemptionDistributor d = _ready();
        vm.prank(address(0xBEEF));
        d.claim(h0, amtOf[h0], proofOf[h0]);
        assertEq(A.balanceOf(h0), 100);
        assertEq(A.balanceOf(address(0xBEEF)), 0);
    }

    // ── Safe custody ───────────────────────────────────────────────────────────
    function test_claim_pullsFromSafe_notDistributor() public {
        RedemptionDistributor d = _ready();
        d.claim(h0, amtOf[h0], proofOf[h0]);
        // Holder paid, Safe debited by exactly the basket, distributor never touched the tokens.
        assertEq(A.balanceOf(h0), 100, "A to h0");
        assertEq(B.balanceOf(h0), 10, "B to h0");
        assertEq(A.balanceOf(safe), TOTAL_A - 100, "Safe debited A");
        assertEq(B.balanceOf(safe), TOTAL_B - 10, "Safe debited B");
        assertEq(A.balanceOf(address(d)), 0, "distributor holds no A");
    }

    // Emergency lever: after activation the Safe revokes a token's allowance to halt claims, then
    // re-approves to resume them — no distributor call in between (activated latches).
    function test_emergencyRevoke_haltsThenResumesClaims() public {
        RedemptionDistributor d = _ready();

        vm.prank(safe);
        A.approve(address(d), 0); // Safe pulls the emergency brake on token A

        vm.expectRevert(); // A's leg can no longer be pulled -> whole atomic basket reverts
        d.claim(h0, amtOf[h0], proofOf[h0]);
        assertFalse(d.hasClaimed(h0), "claim not finalized while halted");

        vm.prank(safe);
        A.approve(address(d), TOTAL_A); // re-approve resumes claims with no activate() call

        d.claim(h0, amtOf[h0], proofOf[h0]);
        assertEq(A.balanceOf(h0), 100, "claim succeeds after re-approval");
        assertTrue(d.hasClaimed(h0));
    }

    // ── guards ───────────────────────────────────────────────────────────────
    function test_claim_revertsBeforeActivate() public {
        RedemptionDistributor d = _deploy();
        _fund(d);
        vm.expectRevert(RedemptionDistributor.NotActivated.selector);
        d.claim(h0, amtOf[h0], proofOf[h0]);
    }

    function test_activate_revertsWhenUnderFunded() public {
        RedemptionDistributor d = _deploy();
        A.mint(safe, TOTAL_A - 1); // Safe holds A short by 1
        B.mint(safe, TOTAL_B);
        vm.startPrank(safe); // fully approved, so the balance shortfall is what trips
        A.approve(address(d), TOTAL_A);
        B.approve(address(d), TOTAL_B);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(RedemptionDistributor.UnderFunded.selector, address(A)));
        d.activate();
    }

    function test_activate_revertsWhenNotApproved() public {
        RedemptionDistributor d = _deploy();
        A.mint(safe, TOTAL_A); // Safe holds the full basket ...
        B.mint(safe, TOTAL_B);
        vm.startPrank(safe); // ... but A is under-approved by 1
        A.approve(address(d), TOTAL_A - 1);
        B.approve(address(d), TOTAL_B);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(RedemptionDistributor.NotApproved.selector, address(A)));
        d.activate();
    }

    function test_activate_twiceReverts() public {
        RedemptionDistributor d = _ready();
        vm.expectRevert(RedemptionDistributor.AlreadyActivated.selector);
        d.activate();
    }

    function test_doubleClaim_reverts() public {
        RedemptionDistributor d = _ready();
        d.claim(h0, amtOf[h0], proofOf[h0]);
        vm.expectRevert(RedemptionDistributor.AlreadyClaimed.selector);
        d.claim(h0, amtOf[h0], proofOf[h0]);
    }

    function test_tamperedAmounts_revertInvalidProof() public {
        RedemptionDistributor d = _ready();
        vm.expectRevert(RedemptionDistributor.InvalidProof.selector);
        d.claim(h0, _mem(101, 10), proofOf[h0]); // 1 wei more A than the leaf
    }

    function test_wrongProof_revertInvalidProof() public {
        RedemptionDistributor d = _ready();
        vm.expectRevert(RedemptionDistributor.InvalidProof.selector);
        d.claim(h0, amtOf[h0], proofOf[h1]); // someone else's proof
    }

    function test_lengthMismatch_reverts() public {
        RedemptionDistributor d = _ready();
        uint256[] memory one = new uint256[](1);
        one[0] = 100;
        vm.expectRevert(RedemptionDistributor.LengthMismatch.selector);
        d.claim(h0, one, proofOf[h0]);
    }

    // ── constructor validation ─────────────────────────────────────────────────
    function test_ctor_revertsOnLengthMismatch() public {
        address[] memory tk = new address[](2);
        tk[0] = address(A);
        tk[1] = address(B);
        uint256[] memory tot = new uint256[](1);
        tot[0] = TOTAL_A;
        vm.expectRevert(bytes("length mismatch"));
        new RedemptionDistributor(root, tk, tot, safe);
    }

    function test_ctor_revertsOnTooManyTokens() public {
        uint256 n = 11; // MAX_PAYOUT_TOKENS is 10 for the one-off GIP-151 basket.
        address[] memory tk = new address[](n);
        uint256[] memory tot = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            tk[i] = address(uint160(i + 1));
            tot[i] = 1;
        }
        vm.expectRevert(bytes("too many tokens"));
        new RedemptionDistributor(root, tk, tot, safe);
    }

    function test_ctor_revertsOnDuplicateToken() public {
        address[] memory tk = new address[](2);
        tk[0] = address(A);
        tk[1] = address(A);
        uint256[] memory tot = new uint256[](2);
        tot[0] = 1;
        tot[1] = 1;
        vm.expectRevert(bytes("duplicate token"));
        new RedemptionDistributor(root, tk, tot, safe);
    }

    function test_ctor_revertsOnZeroTotal() public {
        address[] memory tk = new address[](2);
        tk[0] = address(A);
        tk[1] = address(B);
        uint256[] memory tot = new uint256[](2);
        tot[0] = TOTAL_A;
        tot[1] = 0;
        vm.expectRevert(bytes("zero total"));
        new RedemptionDistributor(root, tk, tot, safe);
    }
}
