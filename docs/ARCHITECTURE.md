# Architecture

`gnoredeem` is the app behind the GIP-151 GnosisDAO treasury redemption — a one-time,
opt-in, pro-rata redemption. Holders deposit GNO or osGNO during a fixed window; after
the window closes an off-chain pipeline builds a Merkle distribution of a payout basket;
holders then claim their basket. The on-chain pieces are immutable and admin-free — no
owner, no upgrade, no pause.

The repo has three independent parts:

| Path         | Stack                                     | Role                                    |
| ------------ | ----------------------------------------- | --------------------------------------- |
| `contracts/` | Foundry · Solidity `^0.8.24`              | The two redemption contracts + deploy   |
| `offchain/`  | Bun · TypeScript · viem                   | Build the claim Merkle tree from chain  |
| `web/`       | Vite · React 19 · wagmi v2 · RainbowKit   | Deposit / claim UI (Gnosis Chain only)  |

## Contracts (`contracts/src/`)

Two immutable, admin-free contracts. Neither ever custodies value between phases: the
deposit contract forwards stake to the Safe on receipt, and the distributor pulls the
payout basket straight from the Safe at claim time.

### `RedemptionDeposit.sol` — the deposit window

- Holders opt in with `deposit(token, amount)` for GNO or osGNO (an ERC20 approval is
  required first). The contract **never custodies**: each deposit is forwarded to the
  redemption `safe` in the same call (checks-effects-interactions; a `transferFrom` that
  tolerates non-standard ERC20 return values).
- It records the **raw** per-holder and per-token amounts in storage and a `Deposited`
  event — the ground-truth record the Merkle tree is later rebuilt from.
- Immutables fixed at deploy: `gno`, `osgno`, `safe`, `deadline` (window end, inclusive),
  and `osgnoRate` (the osGNO→GNO rate frozen at the snapshot). The contract reads no oracle
  at runtime.
- No withdrawal — it is deployed only after the vote has passed.

### `RedemptionDistributor.sol` — the claim phase

A pull-claim Merkle distributor over the payout basket, running in **Safe custody**: the
basket never enters this contract.

- **One leaf per holder** encodes that holder's entire multi-asset basket, so a single
  `claim(account, amounts, proof)` transfers every payout token in one transaction. Anyone
  may submit a claim; funds always go to `account`. `MAX_PAYOUT_TOKENS = 10`.
- Committed at deploy and immutable: `merkleRoot`, the ordered `payoutTokens`, the per-token
  `payoutTotal`, and the funding `safe`.
- **Safe custody, allowance-funded.** The basket stays in the redemption Safe. The Safe
  funds the distributor by **approving** it (ERC20 allowance) for each committed total;
  `claim()` then pulls each holder's legs `Safe → holder` via `transferFrom`. Because funds
  never leave the Safe, the Safe (GnosisDAO multisig) retains custody for issue/emergency
  handling — the emergency lever is the allowance itself: set a token's allowance to 0 to
  halt its claims, re-approve to resume, with no redeploy and no admin role on the contract.
- `activate()` is permissionless and one-shot. It reverts unless, for every token, the Safe
  both **holds ≥** (`UnderFunded`) and **has approved ≥** (`NotApproved`) the committed
  total. Note this is a **point-in-time readiness check, not a durable solvency guarantee**:
  after activation the Safe's balance or allowance can drop (the intended emergency lever, or
  an ordinary Safe spend), reverting affected claims until restored. That weaker guarantee —
  versus escrowing the basket in the contract — is the deliberate price of Safe custody.
- **Atomic, all-or-nothing claim.** A basket succeeds only if every leg transfers; a payout
  token that blocks transfer to a holder, or a Safe balance/allowance shortfall on any leg,
  makes the whole basket unclaimable until the condition clears. Curate the basket to only
  standard, non-blocking ERC20s.
- No deadline, no sweep, no admin: an unclaimed basket stays claimable forever (it simply
  remains in the Safe).
- Leaf format (must match the off-chain builder):
  `keccak256(bytes.concat(keccak256(abi.encode(account, amounts))))` — OpenZeppelin
  `StandardMerkleTree` with `['address','uint256[]']` encoding, verified on-chain by
  `MerkleProof.verifyCalldata`.

### Scripts & tests (`contracts/script/`, `contracts/test/`)

- `Deploy.s.sol` — deploys `RedemptionDeposit`. The verified GNO / osGNO / rate-provider
  addresses are hardcoded; the human-supplied `SAFE` / `DEADLINE` / `OSGNO_RATE` /
  `SNAPSHOT_BLOCK` come from env and are guarded (chain id `100`, deadline sanity, the rate
  banded ±5% against the live oracle) so a fat-finger reverts, and every immutable is
  re-asserted after deploy.
- `preflight-osgno-rate.sh` — asserts `OSGNO_RATE == getRate()` exactly at the snapshot
  block (the precise check the deploy script cannot do mid-broadcast).
- `DeployDistributor.s.sol` — reads root / tokens / totals straight from the build-merkle
  output JSON and, rather than trust that operator-supplied manifest, binds it to chain
  before broadcasting. Inputs are explicit: `MANIFEST_PATH` (no default) and
  `EXPECTED_DEPOSIT_CONTRACT`. It verifies, in order: the manifest's deposit contract equals
  the expected pin; the frozen `osgnoRate`, deposit token identities, and `totalDeposited`
  match the deposit contract's immutables and state; the cutoff block is finalized and
  strictly after the deadline (refusing preview roots); the root re-derives from the listed
  leaves, which must end exactly at `holderCount` and sum to the committed totals; and the
  Safe's balance covers every total. It then constructs the distributor with the `safe`
  sourced from the deposit contract (not the manifest) and re-asserts the deployed state.
  The console output tells the operator to have the Safe **approve** the distributor for the
  printed totals, then call `activate()`.
- `contracts/Makefile` — `install-contract-deps` fetches the pinned forge-std + OpenZeppelin
  into `lib/` (gitignored, not git submodules — a fresh clone must run it before
  `forge build`).
- `test/` — Foundry tests for the deposit contract, the distributor (including Safe-custody
  claims, `NotApproved`, and the emergency revoke/resume lever), the deploy script (with
  production / undercount / wrong-deposit fixtures under `test/fixtures/`), the end-to-end
  Merkle integration, and PoCs for reviewed findings.

## Off-chain Merkle pipeline (`offchain/`)

Turns the on-chain deposit record into the claim manifest. Bun/TypeScript with viem:

1. **`fetch-deposits.ts`** — reconstructs the canonical deposit set from chain: reads the
   deployed contract's immutables, walks `Deposited` events in fixed-size chunks, and
   requires an explicit `--to-block` that is finalized and strictly after the deadline. It
   reconciles the reconstructed sums against the contract's `totalDeposited()` at that block,
   then emits a build config carrying on-chain provenance (rate, totals, cutoff block/hash,
   finalized head). This binds the root to chain state — an operator cannot paste a stale
   rate or a truncated deposit set without the build failing.
2. **`build-merkle.ts`** — applies the frozen `osgnoRate` to get each holder's GNO-equivalent
   weight (`rawGNO + rawOsGNO * rate / 1e18`, floored once per holder), allocates each basket
   asset pro-rata by weight (floor; flooring dust stays in the Safe), builds the
   `StandardMerkleTree`, and emits the root, the committed per-token totals (for the
   distributor constructor), and a per-holder manifest of `{ amounts, proof }`. It re-checks
   the config against the provenance, so a tampered or edited config fails loudly. The leaf
   scheme is byte-for-byte identical to the contract's.

Two preview-only helpers support dry runs (never root-safe — the deploy script refuses their
output): `preview-deposits.ts` reconstructs deposits at chain head while the window may still
be open, and `treasury-nav.ts` reads the redemption Safe's payout-token balances on a Gnosis
fork and emits a build-config so `build-merkle.ts` can be exercised before the Safe is funded
for real. Both feed the same `build-merkle.ts`; neither is used to build a production root.

## Web app (`web/`)

Vite + React 19 + wagmi v2 + RainbowKit, Gnosis Chain only.

- `config.ts` is the single configuration source. The verified token / rate-provider
  addresses are baked in; the deployment-dependent values (deposit & distributor addresses,
  claim date, manifest URL) are placeholders, and the UI degrades to "not open yet" until
  they are set.
- **Deposit** (`App.tsx`, `lib/batchedDeposit.ts`): approve + deposit, with an EIP-5792
  one-click atomic approve+deposit for Safe / 5792-capable wallets and a two-step fallback
  otherwise. Before enabling deposits the UI verifies the deployed contract's `gno` /
  `osgno` / `safe` immutables match the expected config and hard-disables on any mismatch.
- **Claim** (`lib/claim.ts`): fetches the published manifest, finds the connected account's
  leaf, reads the distributor's `activated` / `hasClaimed`, and submits `claim()`. The
  manifest is trusted only for display and the proof bytes — the proof is verified on-chain
  against the immutable root, so a wrong or stale manifest can only revert, never mis-pay.

## End-to-end lifecycle

1. Deploy `RedemptionDeposit` with the frozen rate, deadline, and Safe.
2. Holders deposit GNO / osGNO during the window → forwarded to the Safe, recorded on-chain.
3. After the deadline: `fetch-deposits.ts` → `build-merkle.ts` produce the root, the
   per-token totals, and the manifest.
4. Deploy `RedemptionDistributor` from that manifest (pinned to the deposit contract); the
   Safe **approves** the distributor for the committed basket; anyone calls `activate()`.
5. Holders claim their basket through the web app; each claim pulls the basket Safe → holder.

## Design properties

- **Immutable & admin-free on-chain** — no owner, upgrade, or pause on either contract.
- **No custody between phases** — the deposit contract forwards stake to the Safe on receipt;
  the distributor pulls the basket from the Safe at claim time and never holds it.
- **Safe-managed with an allowance lever** — the Safe keeps custody of the basket; adjusting
  (or revoking) the distributor's allowance is the emergency control, at the cost of
  `activate()` being a point-in-time rather than durable solvency guarantee.
- **Trust-minimized & reproducible** — the Merkle root is reproducible from on-chain state by
  anyone, and every claim's proof is checked against the immutable root.
- **Fail-loud off-chain and at deploy** — the builder and the deploy script reconcile against
  chain state and abort rather than emit or deploy a wrong root.
