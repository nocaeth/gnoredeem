// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RedemptionDistributor} from "../src/RedemptionDistributor.sol";

/// @title  Deploy RedemptionDistributor from the published Merkle manifest (Gnosis Chain).
/// @notice Reads root / payoutTokens / payoutTotals DIRECTLY from the builder output (offchain/out.json)
///         — no hand transcription — and asserts the deployed state matches the manifest, IN ORDER.
///         The Merkle leaf binds `amounts` only POSITIONALLY, so a transposed token order would
///         silently mis-pay the whole basket; loading from the manifest + the post-deploy order
///         asserts make that impossible to ship (audit finding H1).
/// @dev    Usage:
///           MANIFEST_PATH=../offchain/out.json \
///           forge script script/DeployDistributor.s.sol:DeployDistributor --rpc-url $RPC_GNOSIS --broadcast --account <acct>
///         Then fund the distributor with EXACTLY payoutTotals and call activate().
contract DeployDistributor is Script {
    using stdJson for string;

    function run() external returns (RedemptionDistributor dist) {
        require(block.chainid == 100, "not Gnosis Chain (expected 100)");

        string memory path = vm.envOr("MANIFEST_PATH", string("../offchain/out.json"));
        string memory json = vm.readFile(path);

        bytes32 root = json.readBytes32(".root");
        address[] memory tokens = json.readAddressArray(".payoutTokens");
        string[] memory totalStrs = json.readStringArray(".payoutTotals"); // strings: full uint256 precision
        require(root != bytes32(0), "zero root in manifest");
        require(tokens.length == totalStrs.length, "tokens/totals length mismatch");

        uint256[] memory totals = new uint256[](totalStrs.length);
        for (uint256 i = 0; i < totalStrs.length; i++) {
            totals[i] = vm.parseUint(totalStrs[i]);
        }

        console2.log("chainid ", block.chainid);
        console2.log("manifest", path);
        console2.logBytes32(root);
        for (uint256 i = 0; i < tokens.length; i++) {
            console2.log("  token", tokens[i]);
            console2.log("  total", totals[i]);
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
