# Safe-custody RedemptionDistributor — Design

**Date:** 2026-07-15
**Branch:** `feat/redemption-basket-and-deploy-verification`
**Status:** Implemented — contract, deploy script (H1/M1/H2), tests, and fixtures landed; `forge test` green (42 passing)
**Author:** paired design session

## Goal

Make `RedemptionDistributor` distribute the payout basket from the redemption **Safe** (via ERC20
allowance) instead of from tokens transferred into and custodied by the distributor itself. Funds
never leave the Safe until a holder claims, so the Safe (GnosisDAO multisig) retains control for
issue/emergency handling. The distributor stays admin-free and immutable.

Bundled with this change (same files, same tests) are three confirmed review findings on the deploy
path — **H1, H2, M1** — because H1's fix is *entangled* with the custody change (the constructor now
needs a `safe`, and the correct source is the deposit contract's immutable, which simultaneously
unblocks the broken production deploy).

## Motivation

- Emergency management: with funds in the Safe, an issue is handled by the Safe revoking the
  distributor's ERC20 approval (or moving funds) — no distributor redeploy, no stuck funds.
- The distributor never holds value between funding and claims, reducing its blast radius.

## Design decisions (settled)

1. **Emergency lever = Safe ERC20 approval.** No `pause()`, no roles, no `paused` state. The Safe
   sets allowance to 0 to halt claims of a token; re-approving resumes them. Distributor stays
   admin-free.
2. **`activate()` remains the go-live gate (Approach A).** It validates readiness, then latches.
3. **`activate()` validates BOTH balance and allowance** for every token: the Safe must hold ≥ and
   have approved ≥ each committed total.
4. **Explicit trade-off (accepted):** today, once activated, the basket is locked in the contract so
   every claim is *guaranteed* payable. Under Safe-custody, `activate()` is a **point-in-time
   readiness check**, not a durable solvency guarantee — after activation the Safe can reduce balance
   or allowance (the intended emergency control), reverting affected claims until restored. This
   weaker guarantee is deliberately traded for Safe-side manageability.

## Scope

**In scope**
- `contracts/src/RedemptionDistributor.sol` — Safe-custody model.
- `contracts/script/DeployDistributor.s.sol` — pass `safe` to constructor (H1), pin the deposit
  contract (M1), bound the leaf loop to the manifest array (H2), update funding instructions.
- Tests: `RedemptionDistributor.t.sol`, `DeployDistributor.t.sol`, new fixtures.
- `contracts/test/PlamenFindingsPoC.t.sol` (untracked, in tree) — update calls so the suite compiles.

**Out of scope** (tracked from the review, separate pass)
- L1 (window/finality gate trusts provenance scalars), L2 (per-holder allocation not verified /
  restore VERIFY prompt), L3 (broader deploy negative-test coverage beyond what H1/H2/M1 add), I1
  (`config.chainId` inert). Off-chain builders (`fetch-deposits.ts`, `treasury-nav.ts`,
  `build-merkle.ts`, `preview-deposits.ts`, `config.ts`) — no code changes required by this design;
  `treasury-nav.ts` may keep emitting the now-unused `treasurySafe` meta field (inert, harmless).

## Contract: `RedemptionDistributor.sol`

**State**
- Add `address public immutable safe;`.

**Constructor** — `constructor(bytes32 merkleRoot_, address[] memory tokens, uint256[] memory totals, address safe_)`
- Add `require(safe_ != address(0), "zero safe");`
- Set `safe = safe_;`. All existing token/total validation unchanged.

**`activate()`** — for each payout token `t`:
```solidity
if (IERC20(t).balanceOf(safe) < payoutTotal[t])              revert UnderFunded(t);
if (IERC20(t).allowance(safe, address(this)) < payoutTotal[t]) revert NotApproved(t);
```
then latch `activated = true` and emit `Activated()`. Still permissionless and one-shot.
- Add error `error NotApproved(address token);` (distinct from `UnderFunded` so ops can tell "Safe
  holds it but hasn't approved" from "Safe doesn't hold enough").

**`claim()`** — change the per-leg transfer:
```solidity
if (amt > 0) IERC20(_payoutTokens[i]).safeTransferFrom(safe, account, amt);
```
CEI preserved (`hasClaimed[account] = true` before the transfer loop). `account` still receives.

**NatSpec** — update the contract/function docs to state: funds live in the Safe and are pulled via
allowance; the Safe funds by approving (not transferring); `activate()` checks balance + allowance at
that instant; emergency stop = Safe revokes approval; because `activated` latches, restoring approval
resumes claims with no further distributor call.

## Deploy script: `DeployDistributor.s.sol`

**H1 — source `safe` from the deposit contract, drop the `treasurySafe` requirement**
- Remove `m.safe = json.readAddress(".provenance.treasurySafe");` from `_readManifest` and drop
  `safe` from the `Manifest` struct.
- Cache `address safe = dep.safe();` in `_verifyAgainstDepositContract`; the existing
  `require(m.safe == dep.safe())` check is now vacuous and is removed.
- `_verifySolvency` uses `dep.safe()` (pass `safe` or the deposit address in).
- Constructor call becomes `new RedemptionDistributor(m.root, m.tokens, m.totals, dep.safe());`.
- `_assertMatchesManifest` adds `require(dist.safe() == dep.safe(), "safe mismatch");`.
- Result: a production `fetch-deposits → build-merkle` manifest (no `treasurySafe`, has
  `finalizedHead`) now deploys; the preview manifest is still correctly refused by the
  `finalizedHead`/window check.

**M1 — pin the expected deposit contract**
- `deployFrom(string memory path, address expectedDeposit)`; `run()` reads both `MANIFEST_PATH` and a
  new required `EXPECTED_DEPOSIT_CONTRACT` env (revert if unset), mirroring the existing
  `run()`/`deployFrom` split.
- After `_readManifest`, before any `dep.*` read:
  `require(m.depositContract == expectedDeposit, "provenance.depositContract != expected - refusing");`

**H2 — bound the leaf loop to the actual manifest array**
- After the leaf/conservation loop in `_verifyRootAndConservation`:
  `require(!vm.keyExistsJson(json, string.concat(".manifest[", vm.toString(m.holderCount), "].holder")), "manifest lists more leaves than holderCount");`
- Closes the demonstrated attack (a manifest whose `holderCount` understates its listed leaves,
  leaving unsummed-but-claimable leaves that strand honest late claimers).

**Funding instructions (console output)**
- Change the printed guidance from "transfer EXACTLY payoutTotals from the Safe to the distributor"
  to: "from the Safe, **approve** the distributor for EXACTLY payoutTotals of each token, then call
  activate()". `_verifySolvency`'s Safe-balance check stays (allowance can't be asserted at deploy —
  the Safe approves afterward; note this in a comment).

## Tests & fixtures

**`RedemptionDistributor.t.sol`**
- Extend `MockERC20` with `approve`, `allowance`, `transferFrom` (additive — keep `transfer` so the
  suites that import this mock still compile).
- `_deploy()` passes a `safe` address; `_fund()` mints to `safe` and (pranked as `safe`) approves the
  distributor for each total.
- `test_allHoldersClaim_drainsExactly` asserts the **Safe** drains to 0 (distributor never holds).
- Add tests:
  - `activate()` reverts `NotApproved` when balance is sufficient but allowance is short.
  - `activate()` still reverts `UnderFunded` when the Safe balance is short.
  - `claim()` pulls from the Safe (holder paid, Safe debited).
  - Emergency: after `activate()`, Safe sets allowance to 0 → `claim()` reverts; re-approve → succeeds
    (proves the latch + approval-as-lever behavior).

**`DeployDistributor.t.sol`**
- Payout funding switches from `transfer` to `approve` (prank `SAFE`); `deployFrom(path, DEPOSIT)`
  passes the expected deposit address.
- `test_revert_safeCannotFundBasket` (deploy-time Safe-balance check) unchanged in intent.
- Add:
  - **H1 regression:** a `manifest-production.json` fixture in the fetch-deposits shape (has
    `finalizedHead`, **no** `treasurySafe`) deploys successfully.
  - **H2:** a `manifest-undercount.json` (real 3-leaf root, `holderCount` = 2, `payoutTotals` = sum of
    first two leaves) reverts with "manifest lists more leaves than holderCount".
  - **M1:** a wrong `expectedDeposit` reverts with the pin message.

**`PlamenFindingsPoC.t.sol`** (untracked, in tree)
- Update the 3-arg `RedemptionDistributor` constructions to 4 args and switch funding to a mock Safe +
  approval so the suite compiles; C1 (cross-instance replay) and C3 (atomic multi-leg brick) remain
  demonstrated (C3 now also triggers on Safe balance/allowance shortfalls — note in the comment).

## Off-chain impact

No manifest shape change; the builders and `config.ts` are unchanged. Only the deploy-time operator
runbook changes: fund = "Safe approves the distributor for the printed totals", not "transfer in".

## Risks / trade-offs

- **Weaker durable guarantee** (see decision 4) — accepted, and the emergency lever is the point.
- **M1 operational step:** the deployer must supply `EXPECTED_DEPOSIT_CONTRACT` out-of-band; a wrong
  value fails the deploy loudly (desired). Document it in the script usage.
- **H2 does not prove tree completeness** (Merkle proofs prove inclusion, not exclusion). It closes
  the "listed-but-unsummed leaf" variant; a root committing to leaves *never listed* remains a
  trust-in-builder gap (that is review finding L2, out of scope here).

## Acceptance criteria

1. `forge test --root contracts` passes, including the new custody, `NotApproved`, emergency-revoke,
   H1-production, H2-undercount, and M1-pin tests.
2. The whole `contracts/test` tree (including `PlamenFindingsPoC.t.sol`) compiles.
3. `RedemptionDistributor` holds no tokens at any point; a claim moves tokens Safe → holder.
4. A production-shaped manifest (no `treasurySafe`) deploys; a preview manifest is still refused.
5. `activate()` reverts unless the Safe both holds and has approved ≥ every committed total.
