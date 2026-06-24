# Architecture

`gnoredeem` is the app behind the GIP-151 GnosisDAO treasury redemption — a one-time,
opt-in, pro-rata redemption. Holders deposit GNO or osGNO during a fixed window; after
the window closes an off-chain pipeline builds a Merkle distribution of a payout basket;
holders then claim their basket. The on-chain pieces are immutable and admin-free — no
owner, no upgrade, no pause.

The repo has three independent parts:

| Path         | Stack                                          | Role                                  |
| ------------ | ---------------------------------------------- | ------------------------------------- |
| `contracts/` | Foundry · Solidity `^0.8.24`                   | The two redemption contracts + deploy |
| `offchain/`  | Bun · TypeScript                               | Build the claim Merkle tree from chain |
| `web/`       | Vite · React 19 · wagmi v2 · RainbowKit        | Deposit / claim UI (Gnosis Chain only) |

## Contracts (`contracts/src/`)

Two immutable, admin-free contracts.

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

- A pull-claim Merkle distributor. **One leaf per holder** encodes that holder's entire
  multi-asset basket, so a single `claim(account, amounts, proof)` transfers every payout
  token in one transaction. Anyone may submit a claim; funds always go to `account`.
- Committed at deploy and immutable: `merkleRoot`, the ordered `payoutTokens`, and the
  per-token `payoutTotal`.
- `activate()` is permissionless but reverts unless the contract already holds ≥ every
  committed total — a **solvency gate**, so claims can never open under-funded and early
  claimers cannot strand late ones.
- No deadline, no sweep, no admin: an unclaimed basket stays claimable forever.
  `MAX_PAYOUT_TOKENS = 10`.
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
  output JSON (`MANIFEST_PATH`, no default) and re-asserts the deployed state matches it.
- `Makefile` — `install-contract-deps` fetches the pinned forge-std + OpenZeppelin `v5.1.0`
  into `lib/` (gitignored, not git submodules — a fresh clone must run it before `forge build`).
- `test/` — Foundry tests for the deposit contract, the distributor, the deploy script, and
  the end-to-end Merkle integration.

## Off-chain Merkle pipeline (`offchain/`)

Turns the on-chain deposit record into the claim manifest. Two Bun/TypeScript steps:

1. **`fetch-deposits.ts`** — reconstructs the canonical deposit set from chain with viem:
   reads the deployed contract's immutables, walks `Deposited` events in fixed-size chunks,
   and requires an explicit `--to-block` that is finalized and strictly after the deadline.
   It reconciles the reconstructed sums against the contract's `totalDeposited()` at that
   block, then emits a build config carrying on-chain provenance (rate, totals, cutoff
   block/hash). This binds the root to chain state — an operator cannot paste a stale rate
   or a truncated deposit set without the build failing.
2. **`build-merkle.ts`** — applies the frozen `osgnoRate` to get each holder's
   GNO-equivalent weight (`rawGNO + rawOsGNO * rate / 1e18`, floored once per holder),
   allocates each basket asset pro-rata by weight (floor; flooring dust stays in the Safe),
   builds the `StandardMerkleTree`, and emits the root, the committed per-token totals (for
   the distributor constructor), and a per-holder manifest of `{ amounts, proof }`. It
   re-checks the config against the provenance, so a tampered or edited config fails loudly.
   The leaf scheme is byte-for-byte identical to the contract's.

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
4. Deploy `RedemptionDistributor` from that manifest; the Safe funds it with the basket;
   anyone calls `activate()`.
5. Holders claim their basket through the web app.

## Design properties

- **Immutable & admin-free on-chain** — no owner, upgrade, or pause on either contract.
- **Trust-minimized** — the deposit contract never custodies; the distributor cannot open
  under-funded; the Merkle root is reproducible from on-chain state by anyone.
- **Fail-loud off-chain** — every step reconciles against chain state and aborts rather
  than emit a wrong root.
