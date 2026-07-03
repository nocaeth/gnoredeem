// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RedemptionDistributor} from "../src/RedemptionDistributor.sol";

/// @notice Exercises the manifest -> on-chain deploy path used by DeployDistributor.s.sol: the
///         committed root/tokens/totals must round-trip through the constructor and be readable
///         back IN ORDER (this is the safety mechanism against a transposed tokens[] — audit H1).
contract DeployDistributorTest is Test {
    using stdJson for string;

    function test_deployFromManifest_matchesInOrder() public {
        string memory projectRoot = vm.projectRoot();
        string memory localFixture = string.concat(projectRoot, "/test/fixtures/manifest.json");
        string memory rootFixture = string.concat(projectRoot, "/contracts/test/fixtures/manifest.json");
        string memory json = vm.readFile(vm.isFile(localFixture) ? localFixture : rootFixture);
        bytes32 root = json.readBytes32(".root");
        address[] memory tokens = json.readAddressArray(".payoutTokens");
        string[] memory totalStrs = json.readStringArray(".payoutTotals");
        uint256[] memory totals = new uint256[](totalStrs.length);
        for (uint256 i = 0; i < totalStrs.length; i++) {
            totals[i] = vm.parseUint(totalStrs[i]);
        }

        RedemptionDistributor d = new RedemptionDistributor(root, tokens, totals);

        assertEq(d.merkleRoot(), root, "root round-trips");
        address[] memory oc = d.payoutTokens();
        assertEq(oc.length, tokens.length, "token count");
        for (uint256 i = 0; i < tokens.length; i++) {
            assertEq(oc[i], tokens[i], "token order preserved");
            assertEq(d.payoutTotal(tokens[i]), totals[i], "per-token total");
        }
    }
}
