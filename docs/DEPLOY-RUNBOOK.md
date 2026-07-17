# Production Runbook — from deposit data to a deployed distributor

Operator guide for the GIP-151 redemption **claim phase**: turn the frozen deposit set into a
Merkle distribution of the payout basket and deploy `RedemptionDistributor` on Gnosis Chain.

Every step fails loud — a bad rate, a truncated deposit set, a wrong token, an unfunded Safe, or
a preview root all abort rather than ship. Do not hand-edit intermediate JSON; each file is
produced by a script and re-verified downstream.

## Where we are

- ✅ Deposit window **closed** (deadline `1784289600` = 2026-07-17 12:00 UTC).
- ✅ Deposit set **captured**: `offchain/deposits-snapshot.json` — 92 holders, reconciled against
  on-chain `totalDeposited()` at the finalized cutoff. This is the immutable record; the steps
  below re-derive from chain and must reproduce it exactly.
- ⛔ Safe **not yet funded** with the payout basket.
- ⛔ Distributor **not deployed**.

## Pinned constants (verified on-chain)

| Thing | Value |
|---|---|
| Chain | Gnosis, id `100` |
| Deposit contract | `0xB53e4a513C1fbb11a66Da851643126D933489C4D` |
| Redemption Safe (funding source) | `0xD8cD32876624bE785E7CbdA82bC93f585e8b1C2D` |
| Cutoff block (`--to-block`) | `47248794` (finalized, ts `1784289820` > deadline) |
| Scan start (`--from-block`) | `47011542` (deposit contract deploy block) |
| Frozen `osgnoRate` | `1160486933936328411` |
| Payout basket (7 tokens) | wstETH, WXDAI, COW, SAFE, HOPR, PNK, auraBAL — see `offchain/config.json` |
| Excluded (deposit tokens) | GNO `0x9C58…CEdb`, osGNO `0xF490…d1A0` — never in the basket |

Secrets live in `offchain/.env` (`ENVIO_API_KEY`/`HYPERRPC` for HyperSync logs, `GNOSIS_RPC` for
state reads) and are read by the tools — never put them in this doc or in `config.json`.

All `bun` commands run from `offchain/`; the `forge` command runs from `contracts/`.

---

## Step 1 — GnosisDAO funds the Safe (precondition, off-tooling)

GnosisDAO transfers the payout basket into the redemption Safe `0xD8cD…1C2D`.

**Critical:** the Safe's **entire balance** of each payout token becomes that token's basket leg —
`treasury-basket.ts` reads the full balance. Fund with **exactly** the amounts earmarked for
redeemers, and hold no unrelated balance of those 7 tokens in this Safe. GNO/osGNO already sit in
the Safe (deposits were forwarded there) and are excluded by design.

Do not run the following steps until funding is complete and final.

---

## Step 2 — Verify the payout token addresses on-chain

Confirm all 7 addresses are the exact tokens (symbol + decimals) on Gnosis and that none is a
deposit token, before they influence anything.

```bash
cd offchain
bun verify-tokens.ts
```

**Expect:** `OK` for all 7 tokens and `verified 7 payout tokens on Gnosis against config`.
**Aborts if:** any on-chain symbol/decimals ≠ `config.json`, an address is not an ERC20, or a
listed token equals the deposit contract's `gno()`/`osgno()`.

---

## Step 3 — Read the basket from the funded Safe

Snapshot the Safe's live payout-token balances (real chain, no fork) into `basket.json`.

```bash
cd offchain
# default reads at the finalized head; pin a block for a reproducible snapshot:
bun treasury-basket.ts basket.json --basket-block <FINALIZED_BLOCK_AFTER_FUNDING>
```

**Produces:** `basket.json` = `[{ token, symbol, total }]` (each `total` is the Safe's raw balance).
**Expect:** one line per funded token and `wrote basket.json`.
**Aborts if:** the Safe holds none of the payout tokens (empty basket), a symbol/decimals mismatch,
or a deposit token is listed. Zero-balance tokens are skipped with a log line — if a token you
funded is missing, stop and investigate (wrong token, wrong Safe, or funding not final).

> The Safe is derived from the deposit contract's `safe()` immutable — it cannot be pointed
> elsewhere by hand.

---

## Step 4 — Build the root-safe config (deposits + basket + provenance)

Re-fetch the frozen deposit set over HyperSync, reconcile it against chain, and merge the basket
into one build config. Use the **same** cutoff/scan blocks as the snapshot so the deposits are
byte-identical to `deposits-snapshot.json`.

```bash
cd offchain
bun fetch-deposits.ts \
  0xB53e4a513C1fbb11a66Da851643126D933489C4D \
  basket.json \
  build-config.json \
  --to-block 47248794 --from-block 47011542
```

**Produces:** `build-config.json` (deposits + basket + `meta` provenance: rate, cutoff block/hash,
finalized head, `totalDeposited`, holder count).
**Expect:** `logs via HyperRPC …`, `92 holders`, and `reconciled vs on-chain totalDeposited … (match)`.
**Aborts if:** the reconstructed sums ≠ on-chain `totalDeposited()` (incomplete logs), the cutoff is
not finalized, or the cutoff is not strictly after the deadline.

**HyperRPC rate limit:** if the shared key 429s, force the public RPC for this run (identical,
reconciled data):
```bash
: > /tmp/empty.env
GNOSIS_RPC=https://rpc.gnosischain.com \
  bun --env-file=/tmp/empty.env fetch-deposits.ts \
  0xB53e4a513C1fbb11a66Da851643126D933489C4D basket.json build-config.json \
  --to-block 47248794 --from-block 47011542
```

**Cross-check (recommended):** the `deposits` and `meta.totalDeposited` in `build-config.json` must
equal those in the committed `deposits-snapshot.json`. Any difference means the deposit set changed
under you — stop.

---

## Step 5 — Build the Merkle tree and claim manifest

Weight each holder (`rawGno + rawOsgno * osgnoRate / 1e18`, floored once), allocate each basket
asset pro-rata, and emit the root, the per-token committed totals, and the per-holder manifest.

```bash
cd offchain
bun build-merkle.ts build-config.json out.json
```

**Produces:** `out.json` — `{ root, payoutTokens, payoutSymbols, payoutTotals, dust, holderCount,
provenance, manifest[{holder, amounts, proof}] }`.
**Expect:** a `root:`, `holders: 92`, and a `total=…  dust=…` line per token.
**Aborts if:** the config rate ≠ its provenance rate, deposit sums ≠ provenance totals, a basket
token allocates 0 to everyone (too small), or the basket exceeds `MAX_PAYOUT_TOKENS = 10`.

> `payoutTokens[i]` and every leaf's `amounts[i]` are emitted in the same basket order — this
> ordering is carried into the deploy and re-checked on-chain (see Step 6, check 4/5 and the
> post-deploy assert).

---

## Step 6 — Deploy `RedemptionDistributor`

Deploy from `out.json`. The script re-binds the operator-supplied manifest to chain and **aborts
the deploy** on any mismatch — it never trusts the JSON. Funding (Step 1) must be complete: check 6
requires the Safe to already hold every committed total.

```bash
cd contracts
# one-time on a fresh clone: make install-contract-deps
MANIFEST_PATH=../offchain/out.json \
EXPECTED_DEPOSIT_CONTRACT=0xB53e4a513C1fbb11a66Da851643126D933489C4D \
forge script script/DeployDistributor.s.sol:DeployDistributor \
  --rpc-url "$RPC_GNOSIS" --broadcast --account <deployer-account>
```

The script verifies, in order, and fails the deploy if any check fails:

1. **Deposit pin** — `provenance.depositContract` == `EXPECTED_DEPOSIT_CONTRACT`.
2. **Frozen rate + deposit set** — manifest `osgnoRate` / `totalDeposited` / `gno` / `osgno` / `safe`
   match the deposit contract's immutables and mappings.
3. **Window closed** — cutoff strictly after the deadline **and** finalized (this is what refuses a
   preview root).
4. **Root** — every leaf is rebuilt exactly as `claim()` does and verified against the manifest root.
5. **Conservation** — leaves sum to `payoutTotals` per token; the manifest lists no leaves beyond
   `holderCount`.
6. **Solvency** — the Safe holds ≥ every committed total (allowance is checked later, at `activate()`).

On success it prints `RedemptionDistributor <address>`, `all pre-deploy checks: PASS`, the
post-deploy manifest assert (including token-order/identity), and the **exact approve amounts**.

Record the deployed address, the tx hash, and the printed `token → approve amount` table.

---

## Step 7 — Go live (post-deploy)

The distributor holds nothing; the basket stays in the Safe and is pulled at claim time.

1. **From the Safe**, `approve(distributor, amount)` for **exactly** each `payoutTotal` the deploy
   printed (one approval per token). Approving the exact totals leaves no residual allowance.
2. Call `activate()` (permissionless). It reverts unless, for **every** token, the Safe both holds
   (`UnderFunded`) and has approved (`NotApproved`) ≥ the committed total. Once it latches, claims open.

After activation, claims can be submitted per holder (`offchain/claim-all.ts` or the web app). The
emergency lever is the Safe's allowance: set a token's allowance to 0 to halt its claims, re-approve
to resume — no redeploy, no admin role.

---

## Abort / rollback

- **Before Step 6 broadcast:** nothing is on-chain — fix the input and re-run from the failing step.
- **After deploy, before `activate()`:** the distributor is inert (claims revert `NotActivated`). If
  the root is wrong, simply do not approve/activate it and deploy a corrected one; the immutable
  contract stays dormant with no funds.
- **After `activate()`:** revoke allowances (set to 0) from the Safe to halt claims. Funds never left
  the Safe, so custody is retained throughout.
