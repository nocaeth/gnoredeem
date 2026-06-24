// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RedemptionDistributor} from "../src/RedemptionDistributor.sol";
import {MockERC20} from "./RedemptionDistributor.t.sol";

/// @notice End-to-end seam test: the OFF-CHAIN builder (offchain/build-merkle.ts, via OZ
///         StandardMerkleTree) must produce a root + proof that the ON-CHAIN distributor accepts.
///         The constants below are the LITERAL output of
///         `bun build-merkle.ts fixture.example.json` (offchain/out.json) — if the two sides ever
///         diverge on leaf encoding or pair hashing, claim() reverts InvalidProof and this fails.
contract RedemptionMerkleIntegrationTest is Test {
    bytes32 constant ROOT = 0xadd678621aad1bac3f5c07807c66de2621f6a4fd96fdf0382f65d6b507f766ad;
    address constant HOLDER = address(0xA0); // first manifest holder (0x..a0)

    function test_offchainProof_verifiesOnchain() public {
        MockERC20 usdc = new MockERC20("USDC.e");
        MockERC20 cow = new MockERC20("COW");

        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(cow);
        uint256[] memory totals = new uint256[](2);
        totals[0] = 999; // payoutTotals from the builder
        totals[1] = 9;

        RedemptionDistributor d = new RedemptionDistributor(ROOT, tokens, totals);
        usdc.mint(address(d), 999);
        cow.mint(address(d), 9);
        d.activate();

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 303; // HOLDER's basket from the manifest
        amounts[1] = 3;

        bytes32[] memory proof = new bytes32[](2);
        proof[0] = 0xadb2e29fb726e32db0dff2cf5a488025bf40b8bd43b6dbe00c58bb452f85fe44;
        proof[1] = 0xeb876f14bd4607f1da7638626e36b922812c8aa4dfd577fa912b030cb4bc616a;

        d.claim(HOLDER, amounts, proof);

        assertEq(usdc.balanceOf(HOLDER), 303, "USDC.e delivered");
        assertEq(cow.balanceOf(HOLDER), 3, "COW delivered");
        assertTrue(d.hasClaimed(HOLDER));
    }
}
