# Production build path: HyperSync, real-chain basket, claim-all relayer — Design

**Date:** 2026-07-17
**Branch:** `feat/redemption-basket-and-deploy-verification`
**Status:** Approved — ready for implementation plan
**Author:** paired design session

## Goal

Complete the remaining production tooling for the GIP-151 redemption. The contracts and
Merkle pipeline are done (42 Foundry tests green); this work closes three gaps in the
off-chain path so the post-deadline build → deploy → claim can run entirely on real Gnosis
chain state:

1. **Real-chain basket reader** — replace the Tenderly-fork basket snapshot with a live
   Gnosis read of the redemption Safe.
2. **HyperSync log fetching** — migrate the production deposit-ingest path off chunked
   public-RPC `getLogs` onto HyperRPC.
3. **Claim-for-all relayer** — a script that submits `claim()` for every holder.

Context: `Deploy.s.sol` fixes `DEADLINE = 1784289600` (2026-07-17 12:00 UTC). The deposit
contract (`0xB53e…9C4D`) is live; the window closes today; the distributor is not yet
deployed. This is the real post-deadline moment, so these three pieces are the critical path.

## Scope

**In scope**
- `offchain/treasury-basket.ts` (new) — real-chain production basket reader.
- `offchain/fetch-deposits.ts` — migrate `getLogs` to HyperRPC (calls stay on real RPC).
- `offchain/claim-all.ts` (new) — batch claim relayer.
- Tests: e2e for `claim-all.ts` (Anvil), unit tests for the basket transform and the
  transport-selection fallback.

**Out of scope**
- No Solidity changes. Contracts and their 42 tests are untouched.
- `treasury-nav.ts` stays as the fork **preview** tool — not deleted, just off the root-safe
  path.
- Multicall3 batching in `claim-all` (YAGNI; sequential is the baseline).
- Out-of-scope review findings from the prior pass (L1/L2/L3/I1).

## Design decisions (settled)

1. **Basket block ≠ deposit cutoff block.** Deposits freeze at the finalized post-deadline
   cutoff; GnosisDAO funds the payout basket later, near distributor deploy. The basket
   reader reads at `--basket-block` (default finalized head), a legitimately different block.
   `DeployDistributor` re-verifies Safe solvency live at deploy, so no root-safe guarantee is
   weakened.
2. **`treasury-basket.ts` outputs `basket.json`**, not a full build-config — the exact
   `[{token, symbol, total}]` shape `fetch-deposits.ts` already consumes. All root-safe
   provenance/reconciliation stays owned by `fetch-deposits.ts`; nothing downstream changes.
3. **HyperRPC for logs only.** Mirror the proven `preview-deposits.ts` split: HyperRPC
   (`HYPERRPC` / `ENVIO_API_KEY`) for `getLogs`, a real Gnosis RPC for `readContract` /
   `getBlock` / finality / `totalDeposited` reconciliation. The reconciliation tripwire (event
   sums vs `totalDeposited()` at cutoff) is what makes HyperRPC safe to trust.
4. **`claim-all` is sequential, resumable, idempotent.** Re-running skips already-claimed
   holders; funds always land on `account` (permissionless claim). `--dry-run` simulates all
   claims before any broadcast.
5. **`treasury-nav.ts` retained** as the fork preview tool (not deleted).

## Component: `offchain/treasury-basket.ts` (new)

Real-chain analog of `treasury-nav.ts` with the fork removed.

- **Inputs:** a deposit set / provenance source is not required — the Safe and tokens are
  derived from chain. CLI: `bun treasury-basket.ts [out=basket.json]`, `--basket-block N`
  (default finalized head). Env: a real Gnosis RPC (`GNOSIS_RPC` / `HYPERRPC`).
- Derives the Safe from the deposit contract's `safe()` immutable (from `config.json`'s
  `depositContract`). Never hand-typed.
- For each `config.json` payout token: reads on-chain `symbol` / `decimals` / `balanceOf(safe)`
  at `--basket-block`; throws on symbol mismatch, on a listed deposit token (GNO/osGNO), on a
  non-contract address. Skips zero-balance tokens with a log line. Enforces
  `MAX_PAYOUT_TOKENS`, empty-basket → throw.
- **Output:** `basket.json` = `[{token, symbol, total}]` (raw balances).
- Fail-loud: every token verified against chain; a wrong address or symbol aborts.

## Component: `offchain/fetch-deposits.ts` (migrate)

- Add HyperRPC transport for `getLogs`, selected via `HYPERRPC` /
  `ENVIO_API_KEY` (→ `https://100.rpc.hypersync.xyz/<key>`), with a warn-and-fallback to the
  real RPC when unset — same pattern as `preview-deposits.ts`.
- `readContract` / `getBlock` / finality / `totalDeposited` reconciliation stay on the real
  Gnosis RPC (`GNOSIS_RPC`). No change to the required `--to-block`, finality, deadline, or
  reconciliation guards.
- No output-shape change; `build-config.json` is byte-compatible with the current builder.

## Component: `offchain/claim-all.ts` (new)

- **Inputs:** the production manifest (`out.json` from `build-merkle`: `{root, payoutTokens,
  manifest[{holder, amounts, proof}]}`); distributor address (env `DISTRIBUTOR` / arg); relayer
  key (`PRIVATE_KEY`); RPC (`GNOSIS_RPC`). Flags: `--dry-run`.
- **Flow:**
  1. Read distributor `activated` → abort if false.
  2. Multicall-read `hasClaimed[holder]` for every manifest entry.
  3. For each un-claimed holder: `simulateContract` the `claim(holder, amounts, proof)`; on
     `--dry-run` stop after simulation and report.
  4. Otherwise broadcast sequentially with explicit nonce management; wait for receipt; log
     each success/skip/failure with reason.
- **Resumable & idempotent:** a re-run skips already-claimed holders; a holder whose leg
  reverts (blocked token, Safe shortfall) is left for a later run and never silently dropped.
- Never broadcasts a claim that fails simulation; aborts loudly if the distributor is not
  `activated`.

## Data flow (production, post-deadline)

```
treasury-basket.ts (real Safe, live) ─► basket.json
fetch-deposits.ts <deposit> basket.json --to-block N (HyperRPC logs) ─► build-config.json
build-merkle.ts build-config.json out.json ─► root + totals + manifest
DeployDistributor.s.sol (MANIFEST_PATH=out.json, pins deposit) ─► distributor
   → Safe approves distributor for totals → activate()
claim-all.ts out.json (relayer key) ─► claim() per holder → Safe drains to holders
```

## Testing

- **`claim-all.ts` — e2e (Anvil).** Deploy `RedemptionDeposit` + `RedemptionDistributor` from
  a small fixture manifest, fund a mock Safe + approve, `activate()`, run `claim-all.ts`
  against the local node, assert every holder claimed and the Safe drained. Plus unit tests
  for the pure selection logic (skip-claimed, dry-run selection).
- **`treasury-basket.ts` — unit.** Basket transform with a mocked client: exclusion of deposit
  tokens, symbol-mismatch throw, `MAX_PAYOUT_TOKENS` cap, zero-balance skip, empty-basket
  throw. The real-chain read is additionally covered by `fetch-deposits`' downstream
  reconciliation.
- **`fetch-deposits.ts` — unit.** Transport-selection fallback (HyperRPC when set, real RPC
  when unset). No behavior change beyond the existing reconciliation guard.
- **Existing 42 Foundry tests** stay green — no contract changes.

## Error handling

Preserve the codebase's fail-loud ethos. `treasury-basket` throws on wrong token
address/symbol, empty basket, or a listed deposit token. `claim-all` aborts before any
broadcast if the distributor isn't `activated` or a holder's proof fails simulation, and logs
every skip with a reason (never a silent drop).

## Acceptance criteria

1. `treasury-basket.ts` produces a `basket.json` from a live Gnosis read of the Safe that
   `fetch-deposits.ts` consumes unchanged; the fork is no longer on the root-safe path.
2. `fetch-deposits.ts` fetches `Deposited` logs over HyperRPC and still reconciles against
   `totalDeposited()`, aborting on mismatch.
3. `claim-all.ts` claims for every un-claimed holder from a relayer key, is resumable, and has
   a `--dry-run` that broadcasts nothing.
4. New tests pass (`bun test` in `offchain/`, Anvil e2e for claim-all); the 42 Foundry tests
   remain green.
5. No Solidity source changes.
