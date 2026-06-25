#!/usr/bin/env bash
#
# GIP-151 osGNO-rate deploy preflight.
#
# Deploy.s.sol can only sanity-band OSGNO_RATE ±5% against the LIVE rate — it cannot read the rate
# provider's historical value mid-broadcast. This script is the EXACT check: it reads getRate() at the
# GIP-151 snapshot block and asserts it equals the OSGNO_RATE you are about to deploy with, then records
# the snapshot block hash for the deploy artifact. Run it (and paste its output into the deploy record)
# BEFORE running Deploy.s.sol.
#
# Usage:
#   RPC_GNOSIS=<url> SNAPSHOT_BLOCK=<n> OSGNO_RATE=<1e18-scaled> ./preflight-osgno-rate.sh
#
set -euo pipefail

: "${RPC_GNOSIS:?set RPC_GNOSIS (Gnosis Chain RPC, archive node)}"
: "${SNAPSHOT_BLOCK:?set SNAPSHOT_BLOCK (the GIP-151 snapshot block)}"
: "${OSGNO_RATE:?set OSGNO_RATE (the 1e18-scaled value you will pass to Deploy.s.sol)}"

# Stakewise rate provider on Gnosis Chain — must match RATE_PROVIDER in Deploy.s.sol.
RATE_PROVIDER=0x9B1b13afA6a57e54C03AD0428a4766C39707D272

# GIP-151 osGNO snapshot instant: 2026-06-27 00:00:00 UTC (governance-confirmed) — the first 00:00 UTC
# after voting closes (2026-06-26 15:14:44 UTC). The snapshot block is the FIRST Gnosis block at/after this;
# the check below asserts SNAPSHOT_BLOCK is exactly that, so a wrong block number can't slip through.
SNAPSHOT_TS=1782518400

actual=$(cast call "$RATE_PROVIDER" "getRate()(uint256)" --block "$SNAPSHOT_BLOCK" --rpc-url "$RPC_GNOSIS")
actual=${actual%% *} # cast may append a humanized suffix; keep the raw integer
block_hash=$(cast block "$SNAPSHOT_BLOCK" --rpc-url "$RPC_GNOSIS" --field hash)
block_ts=$(cast block "$SNAPSHOT_BLOCK" --rpc-url "$RPC_GNOSIS" --field timestamp)
prev_ts=$(cast block "$((SNAPSHOT_BLOCK - 1))" --rpc-url "$RPC_GNOSIS" --field timestamp)

echo "rate provider  : $RATE_PROVIDER"
echo "snapshot block : $SNAPSHOT_BLOCK"
echo "block hash     : $block_hash"
echo "block ts (unix): $block_ts  (prev $prev_ts)"
echo "snapshot ts    : $SNAPSHOT_TS  (2026-06-27 00:00:00 UTC)"
echo "getRate() @blk : $actual"
echo "OSGNO_RATE     : $OSGNO_RATE"

# (1) SNAPSHOT_BLOCK must be the FIRST block at/after the governance snapshot instant.
if [ "$block_ts" -lt "$SNAPSHOT_TS" ] || [ "$prev_ts" -ge "$SNAPSHOT_TS" ]; then
  echo "MISMATCH: block $SNAPSHOT_BLOCK is not the first block at/after the snapshot ($SNAPSHOT_TS): block_ts=$block_ts prev_ts=$prev_ts — wrong SNAPSHOT_BLOCK." >&2
  exit 1
fi

# (2) The rate at that block must equal the value being deployed.
if [ "$actual" != "$OSGNO_RATE" ]; then
  echo "MISMATCH: getRate() at the snapshot block ($actual) != OSGNO_RATE ($OSGNO_RATE) — DO NOT DEPLOY." >&2
  exit 1
fi

echo "OK: SNAPSHOT_BLOCK is the snapshot instant and OSGNO_RATE equals getRate() there. Record this with the deploy."
