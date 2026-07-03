// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RedemptionDeposit} from "../src/RedemptionDeposit.sol";

interface IRateProvider {
    function getRate() external view returns (uint256);
}

/// @title  Deploy — RedemptionDeposit (GIP-151), Gnosis Chain only
/// @notice The contract's five constructor args are IMMUTABLE and IRREVERSIBLE — a wrong `safe`
///         sends every deposit to the wrong place forever, a stale `osgnoRate` mis-values every
///         osGNO depositor. This script hardcodes the verified, machine-checkable inputs and guards
///         the human-supplied ones so a fat-finger reverts the deploy instead of being silent.
///
/// @dev    Usage (run script/preflight-osgno-rate.sh FIRST — see OSGNO_RATE below):
///           forge script script/Deploy.s.sol:Deploy --rpc-url https://gnosis.drpc.org --broadcast --account <acct>
///
///         Deployment parameters are hardcoded below. SAFE must still be human-verified against the
///         published GIP-151 post — nothing on-chain can check this. OSGNO_RATE is the osGNO->GNO rate
///         (1e18) at SNAPSHOT_BLOCK; this script only sanity-bands it ±5% against the live rate. The
///         exact historical check is a preflight artifact:
///           RPC_GNOSIS=<archive-rpc> SNAPSHOT_BLOCK=46902787 OSGNO_RATE=1160486933936328411 \
///             script/preflight-osgno-rate.sh
contract Deploy is Script {
    // Verified on Gnosis Chain (chainid 100).
    address constant GNO = 0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb;
    address constant OSGNO = 0xF490c80aAE5f2616d3e3BDa2483E30C4CB21d1A0;
    address constant RATE_PROVIDER = 0x9B1b13afA6a57e54C03AD0428a4766C39707D272;

    // GIP-151 deployment parameters.
    address constant SAFE = 0xD8cD32876624bE785E7CbdA82bC93f585e8b1C2D;
    uint256 constant DEADLINE = 1784289600; // 2026-07-17 12:00:00 UTC
    uint256 constant SNAPSHOT_BLOCK = 46902787; // 2026-06-27 00:00:00 UTC
    uint256 constant OSGNO_RATE = 1160486933936328411;

    function run() external returns (RedemptionDeposit dep) {
        require(block.chainid == 100, "not Gnosis Chain (expected 100)");

        require(SAFE != address(0), "SAFE unset");
        require(DEADLINE > block.timestamp, "DEADLINE in the past");
        require(DEADLINE <= block.timestamp + 30 days, "DEADLINE >30d out (window is ~14d) - typo?");
        require(SNAPSHOT_BLOCK > 0, "SNAPSHOT_BLOCK unset - run script/preflight-osgno-rate.sh first");

        // Sanity-band OSGNO_RATE. The plausible range catches a wrong-scale value (e.g. 1e16 / 1e20);
        // the +/-5% band against the live rate catches a stale or copied-wrong number. The snapshot
        // value cannot be exact here (getRate() drifts every block), so this is a fat-finger guard,
        // not an equality check — the human still confirms it equals getRate() at the snapshot block.
        uint256 liveRate = IRateProvider(RATE_PROVIDER).getRate();
        require(OSGNO_RATE >= 0.9e18 && OSGNO_RATE <= 2e18, "OSGNO_RATE outside plausible range (~1e18)");
        uint256 diff = OSGNO_RATE > liveRate ? OSGNO_RATE - liveRate : liveRate - OSGNO_RATE;
        require(diff <= liveRate / 20, "OSGNO_RATE >5% off live rate - stale or wrong?");

        console2.log("chainid             ", block.chainid);
        console2.log("GNO                 ", GNO);
        console2.log("osGNO               ", OSGNO);
        console2.log("safe   (VERIFY!)    ", SAFE);
        console2.log("deadline (unix)     ", DEADLINE);
        console2.log("osgnoRate (snapshot)", OSGNO_RATE);
        console2.log("snapshotBlock       ", SNAPSHOT_BLOCK);
        console2.log("liveRate  (now)     ", liveRate);

        vm.startBroadcast();
        dep = new RedemptionDeposit(GNO, OSGNO, SAFE, DEADLINE, OSGNO_RATE);
        vm.stopBroadcast();

        console2.log("RedemptionDeposit   ", address(dep));

        // Post-deploy invariants: confirm the immutables landed exactly as intended.
        require(address(dep.gno()) == GNO, "gno mismatch");
        require(address(dep.osgno()) == OSGNO, "osgno mismatch");
        require(dep.safe() == SAFE, "safe mismatch");
        require(dep.deadline() == DEADLINE, "deadline mismatch");
        require(dep.osgnoRate() == OSGNO_RATE, "osgnoRate mismatch");
    }
}
