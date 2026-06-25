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
///           SAFE=0x...  DEADLINE=<unix>  OSGNO_RATE=<1e18-scaled>  SNAPSHOT_BLOCK=<n> \
///           forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_GNOSIS --broadcast --account <acct>
///
///         Inputs (env):
///         - SAFE       redemption Safe that RECEIVES all deposits. **Human-verify against the published
///                      GIP-151 post — nothing on-chain can check this.** The script only echoes it.
///         - DEADLINE   unix ts, end of the 14-day window (inclusive: deposits allowed while now <= DEADLINE).
///         - OSGNO_RATE the osGNO->GNO rate (1e18) at the GIP-151 SNAPSHOT BLOCK. This script cannot
///                      re-derive a historical value mid-broadcast — it only sanity-bands it ±5% against
///                      the live rate. The EXACT check is a preflight artifact: run
///                        SNAPSHOT_BLOCK=<n> OSGNO_RATE=<v> script/preflight-osgno-rate.sh
///                      which asserts OSGNO_RATE == getRate() at SNAPSHOT_BLOCK exactly and records the
///                      block hash for the deploy record.
///         - SNAPSHOT_BLOCK the GIP-151 snapshot block. Required and logged here for the deploy artifact;
///                      it is the block the preflight asserted OSGNO_RATE against.
contract Deploy is Script {
    // Verified on Gnosis Chain (chainid 100).
    address constant GNO = 0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb;
    address constant OSGNO = 0xF490c80aAE5f2616d3e3BDa2483E30C4CB21d1A0;
    address constant RATE_PROVIDER = 0x9B1b13afA6a57e54C03AD0428a4766C39707D272;

    function run() external returns (RedemptionDeposit dep) {
        require(block.chainid == 100, "not Gnosis Chain (expected 100)");

        address safe = vm.envAddress("SAFE");
        uint256 deadline = vm.envUint("DEADLINE");
        uint256 osgnoRate = vm.envUint("OSGNO_RATE");
        uint256 snapshotBlock = vm.envUint("SNAPSHOT_BLOCK");

        require(safe != address(0), "SAFE unset");
        require(deadline > block.timestamp, "DEADLINE in the past");
        require(deadline <= block.timestamp + 30 days, "DEADLINE >30d out (window is ~14d) - typo?");
        require(snapshotBlock > 0, "SNAPSHOT_BLOCK unset - run script/preflight-osgno-rate.sh first");

        // Sanity-band OSGNO_RATE. The plausible range catches a wrong-scale value (e.g. 1e16 / 1e20);
        // the +/-5% band against the live rate catches a stale or copied-wrong number. The snapshot
        // value cannot be exact here (getRate() drifts every block), so this is a fat-finger guard,
        // not an equality check — the human still confirms it equals getRate() at the snapshot block.
        uint256 liveRate = IRateProvider(RATE_PROVIDER).getRate();
        require(osgnoRate >= 0.9e18 && osgnoRate <= 2e18, "OSGNO_RATE outside plausible range (~1e18)");
        uint256 diff = osgnoRate > liveRate ? osgnoRate - liveRate : liveRate - osgnoRate;
        require(diff <= liveRate / 20, "OSGNO_RATE >5% off live rate - stale or wrong?");

        console2.log("chainid             ", block.chainid);
        console2.log("GNO                 ", GNO);
        console2.log("osGNO               ", OSGNO);
        console2.log("safe   (VERIFY!)    ", safe);
        console2.log("deadline (unix)     ", deadline);
        console2.log("osgnoRate (snapshot)", osgnoRate);
        console2.log("snapshotBlock       ", snapshotBlock);
        console2.log("liveRate  (now)     ", liveRate);

        vm.startBroadcast();
        dep = new RedemptionDeposit(GNO, OSGNO, safe, deadline, osgnoRate);
        vm.stopBroadcast();

        console2.log("RedemptionDeposit   ", address(dep));

        // Post-deploy invariants: confirm the immutables landed exactly as intended.
        require(address(dep.gno()) == GNO, "gno mismatch");
        require(address(dep.osgno()) == OSGNO, "osgno mismatch");
        require(dep.safe() == safe, "safe mismatch");
        require(dep.deadline() == deadline, "deadline mismatch");
        require(dep.osgnoRate() == osgnoRate, "osgnoRate mismatch");
    }
}
