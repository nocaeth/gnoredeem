// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RedemptionDeposit} from "../src/RedemptionDeposit.sol";

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

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt; // reverts (underflow) without approval
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract RedemptionDepositTest is Test {
    RedemptionDeposit internal dep;
    MockERC20 internal gno;
    MockERC20 internal osgno;

    address internal safe = address(0x5AFE);
    address internal alice = address(0xA11CE);
    uint256 internal deadline;
    uint256 internal constant RATE = 1.2e18; // 1 osGNO = 1.2 GNO

    event Deposited(address indexed holder, address indexed token, uint256 amount);

    function setUp() public {
        gno = new MockERC20("GNO");
        osgno = new MockERC20("osGNO");
        deadline = block.timestamp + 14 days;
        dep = new RedemptionDeposit(address(gno), address(osgno), safe, deadline, RATE);

        gno.mint(alice, 100e18);
        osgno.mint(alice, 50e18);
        vm.startPrank(alice);
        gno.approve(address(dep), type(uint256).max);
        osgno.approve(address(dep), type(uint256).max);
        vm.stopPrank();
    }

    function test_deposit_gno_forwardsToSafe_andCredits() public {
        vm.expectEmit(true, true, false, true, address(dep));
        emit Deposited(alice, address(gno), 10e18);

        vm.prank(alice);
        dep.deposit(address(gno), 10e18);

        assertEq(gno.balanceOf(safe), 10e18, "safe received");
        assertEq(gno.balanceOf(address(dep)), 0, "router custodies nothing");
        assertEq(dep.deposited(alice, address(gno)), 10e18);
        assertEq(dep.totalDeposited(address(gno)), 10e18);
    }

    function test_deposit_bothTokens_creditedSeparately() public {
        vm.startPrank(alice);
        dep.deposit(address(gno), 10e18);
        dep.deposit(address(osgno), 5e18);
        vm.stopPrank();

        assertEq(dep.deposited(alice, address(gno)), 10e18);
        assertEq(dep.deposited(alice, address(osgno)), 5e18);
        assertEq(gno.balanceOf(safe), 10e18);
        assertEq(osgno.balanceOf(safe), 5e18);
    }

    function test_deposit_accumulates() public {
        vm.startPrank(alice);
        dep.deposit(address(gno), 10e18);
        dep.deposit(address(gno), 7e18);
        vm.stopPrank();

        assertEq(dep.deposited(alice, address(gno)), 17e18);
        assertEq(dep.totalDeposited(address(gno)), 17e18);
    }

    function test_revert_afterDeadline() public {
        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(RedemptionDeposit.DepositWindowClosed.selector);
        dep.deposit(address(gno), 1e18);
    }

    function test_deposit_atDeadline_ok() public {
        vm.warp(deadline);
        vm.prank(alice);
        dep.deposit(address(gno), 1e18);
        assertEq(dep.deposited(alice, address(gno)), 1e18);
    }

    function test_revert_unsupportedToken() public {
        MockERC20 other = new MockERC20("XXX");
        vm.prank(alice);
        vm.expectRevert(RedemptionDeposit.UnsupportedToken.selector);
        dep.deposit(address(other), 1e18);
    }

    function test_revert_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(RedemptionDeposit.ZeroAmount.selector);
        dep.deposit(address(gno), 0);
    }

    function test_revert_withoutApproval() public {
        address bob = address(0xB0B);
        gno.mint(bob, 1e18);
        vm.prank(bob);
        vm.expectRevert(RedemptionDeposit.TransferFailed.selector);
        dep.deposit(address(gno), 1e18);
    }

    function testFuzz_creditsExactAmount(uint96 a, uint96 b) public {
        vm.assume(a > 0 && b > 0);
        gno.mint(alice, uint256(a) + b);
        vm.startPrank(alice);
        dep.deposit(address(gno), a);
        dep.deposit(address(gno), b);
        vm.stopPrank();
        assertEq(dep.deposited(alice, address(gno)), uint256(a) + b);
    }
}
