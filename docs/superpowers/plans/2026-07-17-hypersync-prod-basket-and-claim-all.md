# HyperSync fetch, real-chain basket, claim-all relayer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the off-chain production tooling so the GIP-151 post-deadline build → deploy → claim runs on real Gnosis chain state: HyperRPC log fetching, a fork-free basket reader, and a claim-for-all relayer.

**Architecture:** Three additions to `offchain/`, no Solidity source changes. `treasury-basket.ts` reads the live Safe balances and emits the `basket.json` that the existing hardened `fetch-deposits.ts` already consumes; `fetch-deposits.ts` gains a HyperRPC transport for `getLogs` while keeping all reconciliation on a real RPC; `claim-all.ts` iterates the `build-merkle` manifest and submits `claim()` for every un-claimed holder. Each new module splits a pure, injectable core (unit-tested) from a thin CLI wrapper, matching `build-merkle.ts`'s `build()` / `import.meta.main` pattern.

**Tech Stack:** Bun, TypeScript, viem `^2.53.1`, `@openzeppelin/merkle-tree`, Foundry (Anvil) for the claim-all end-to-end test.

## Global Constraints

- Runtime: Bun. Test runner: `bun test` (files named `*.test.ts`). Run from `offchain/`.
- TypeScript style: `const` over `let`; no `any` (use `unknown` + narrowing); named exports; `import type` for type-only imports; early returns.
- Chain: Gnosis, chainId `100`. HyperRPC URL: `https://100.rpc.hypersync.xyz/<ENVIO_API_KEY>` (or `HYPERRPC` verbatim).
- `MAX_PAYOUT_TOKENS = 10` (import from `./config`). Deposit tokens (GNO/osGNO) must never appear in the basket.
- Manifest addresses are lowercased strings; `amounts` are decimal strings; `proof` entries are `0x`-hex.
- Fail-loud: every new module throws on a mismatch or invalid state rather than emitting/broadcasting a wrong result. Never silently skip.
- No changes to `contracts/src/**` or the existing 42 Foundry tests. The only contracts addition allowed is a new **test-only** mock (`contracts/test/mocks/MockERC20.sol`) used by the claim-all e2e.
- `treasury-nav.ts` stays as the fork preview tool — do not delete or edit it.

---

### Task 1: HyperRPC transport for `fetch-deposits.ts`

Migrate the production deposit-ingest path so `Deposited` logs are fetched over HyperRPC, while every state read and reconciliation stays on a real Gnosis RPC. Extract the transport-selection into a pure, testable function.

**Files:**
- Modify: `offchain/fetch-deposits.ts` (imports at 22-26; `client` construction at 60; log loop at 95-103)
- Create: `offchain/fetch-deposits.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export function pickLogRpc(env: Record<string, string | undefined>): { url: string; hyper: boolean }` — resolves the log-fetch RPC URL and whether it is HyperRPC. Reused conceptually by preview parity (not imported elsewhere).

- [ ] **Step 1: Write the failing test**

Create `offchain/fetch-deposits.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { pickLogRpc } from './fetch-deposits'

test('pickLogRpc prefers explicit HYPERRPC', () => {
  const r = pickLogRpc({ HYPERRPC: 'https://custom.hyper/xyz', ENVIO_API_KEY: 'k', GNOSIS_RPC: 'https://rpc' })
  expect(r).toEqual({ url: 'https://custom.hyper/xyz', hyper: true })
})

test('pickLogRpc builds the HyperRPC URL from ENVIO_API_KEY', () => {
  const r = pickLogRpc({ ENVIO_API_KEY: 'abc123', GNOSIS_RPC: 'https://rpc' })
  expect(r).toEqual({ url: 'https://100.rpc.hypersync.xyz/abc123', hyper: true })
})

test('pickLogRpc falls back to the real RPC when no HyperRPC is configured', () => {
  const r = pickLogRpc({ GNOSIS_RPC: 'https://rpc.example' })
  expect(r).toEqual({ url: 'https://rpc.example', hyper: false })
})

test('pickLogRpc falls back to the public default when nothing is set', () => {
  const r = pickLogRpc({})
  expect(r).toEqual({ url: 'https://rpc.gnosischain.com', hyper: false })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd offchain && bun test fetch-deposits.test.ts`
Expected: FAIL — `pickLogRpc` is not exported / not a function.

- [ ] **Step 3: Add `pickLogRpc` and wire a separate log client**

In `offchain/fetch-deposits.ts`, replace the RPC constant block (lines ~26) and add the selector. Change the top of the file so the module is import-safe (guard the CLI body). Concretely:

Replace:
```ts
const RPC = process.env.GNOSIS_RPC ?? process.env.VITE_GNOSIS_RPC ?? 'https://rpc.gnosischain.com'
```
with:
```ts
export function pickLogRpc(env: Record<string, string | undefined>): { url: string; hyper: boolean } {
  if (env.HYPERRPC) return { url: env.HYPERRPC, hyper: true }
  if (env.ENVIO_API_KEY) return { url: `https://100.rpc.hypersync.xyz/${env.ENVIO_API_KEY}`, hyper: true }
  return { url: env.GNOSIS_RPC ?? env.VITE_GNOSIS_RPC ?? 'https://rpc.gnosischain.com', hyper: false }
}

const RPC = process.env.GNOSIS_RPC ?? process.env.VITE_GNOSIS_RPC ?? 'https://rpc.gnosischain.com'
```

Then, where `client` is built (line ~60), add a dedicated log client and a notice:
```ts
const client = createPublicClient({ chain: gnosis, transport: http(RPC) })
const logRpc = pickLogRpc(process.env)
const logClient = createPublicClient({ chain: gnosis, transport: http(logRpc.url) })
console.log(`logs via ${logRpc.hyper ? 'HyperRPC' : 'public RPC'} (${new URL(logRpc.url).host}); state reads via ${new URL(RPC).host}`)
```

In the chunked log loop (line ~101), fetch logs from `logClient` instead of `client`:
```ts
const chunk = await logClient.getLogs({ address: deposit, event: DEPOSITED, fromBlock: start, toBlock: end })
```

All `readContract` / `getBlock` / `totalDeposited` reconciliation calls stay on `client` (real RPC) — do not change them. The reconciliation guard (event sums vs `totalDeposited()` at the cutoff block) is what makes HyperRPC-sourced logs trustworthy; leave it intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd offchain && bun test fetch-deposits.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Sanity-check the module still parses as a script**

Run: `cd offchain && bun build fetch-deposits.ts --target=node > /dev/null && echo OK`
Expected: `OK` (no type/parse error). (A real run needs env + args; this only checks the file compiles.)

- [ ] **Step 6: Commit**

```bash
git add offchain/fetch-deposits.ts offchain/fetch-deposits.test.ts
git commit -m "fetch-deposits: fetch Deposited logs over HyperRPC"
```

---

### Task 2: Real-chain basket reader `treasury-basket.ts`

A fork-free production reader: derive the Safe from the deposit contract, read each `config.json` payout token's live balance in the Safe at a chosen block, and emit `basket.json` in the shape `fetch-deposits.ts` consumes. Model on `treasury-nav.ts` but read real Gnosis chain, output only the basket, and inject the client for testability.

**Files:**
- Create: `offchain/treasury-basket.ts`
- Create: `offchain/treasury-basket.test.ts`
- Modify: `offchain/package.json` (scripts)

**Interfaces:**
- Consumes: `config`, `MAX_PAYOUT_TOKENS`, `PayoutToken` from `./config`.
- Produces:
  - `export type BasketAsset = { token: string; symbol: string; total: string }`
  - `export interface BasketReader { readContract(args: { address: string; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> }`
  - `export async function readBasket(client: BasketReader, opts: { depositContract: string; payoutTokens: readonly PayoutToken[]; blockNumber?: bigint }): Promise<BasketAsset[]>`

- [ ] **Step 1: Write the failing test**

Create `offchain/treasury-basket.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { readBasket, type BasketReader } from './treasury-basket'

const SAFE = getAddress('0x00000000000000000000000000000000000000ff')
const GNO = getAddress('0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb')
const OSGNO = getAddress('0xf490c80aAE5f2616d3e3BDa2483E30C4CB21d1A0')
const WXDAI = getAddress('0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d')

// Fake client: routes (address, functionName) -> value. Unknown routes throw (fail-loud parity).
function fakeClient(spec: {
  safe?: string; gno?: string; osgno?: string
  tokens: Record<string, { symbol: string; decimals: number; balance: bigint }>
}): BasketReader {
  return {
    async readContract({ address, functionName }) {
      const a = getAddress(address)
      if (a === getAddress('0xB53e4a513C1fbb11a66Da851643126D933489C4D')) {
        if (functionName === 'safe') return spec.safe ?? SAFE
        if (functionName === 'gno') return spec.gno ?? GNO
        if (functionName === 'osgno') return spec.osgno ?? OSGNO
      }
      const t = spec.tokens[a]
      if (t) {
        if (functionName === 'symbol') return t.symbol
        if (functionName === 'decimals') return t.decimals
        if (functionName === 'balanceOf') return t.balance
      }
      throw new Error(`unexpected read ${functionName} @ ${a}`)
    },
  }
}

test('readBasket returns verified non-zero balances', async () => {
  const client = fakeClient({ tokens: { [WXDAI]: { symbol: 'WXDAI', decimals: 18, balance: 1000n } } })
  const basket = await readBasket(client, {
    depositContract: '0xB53e4a513C1fbb11a66Da851643126D933489C4D',
    payoutTokens: [{ symbol: 'WXDAI', address: WXDAI }],
  })
  expect(basket).toEqual([{ token: WXDAI, symbol: 'WXDAI', total: '1000' }])
})

test('readBasket throws when a payout token is a deposit token', async () => {
  const client = fakeClient({ tokens: { [GNO]: { symbol: 'GNO', decimals: 18, balance: 5n } } })
  await expect(
    readBasket(client, {
      depositContract: '0xB53e4a513C1fbb11a66Da851643126D933489C4D',
      payoutTokens: [{ symbol: 'GNO', address: GNO }],
    }),
  ).rejects.toThrow(/deposit token/)
})

test('readBasket throws on an on-chain symbol mismatch', async () => {
  const client = fakeClient({ tokens: { [WXDAI]: { symbol: 'NOPE', decimals: 18, balance: 5n } } })
  await expect(
    readBasket(client, {
      depositContract: '0xB53e4a513C1fbb11a66Da851643126D933489C4D',
      payoutTokens: [{ symbol: 'WXDAI', address: WXDAI }],
    }),
  ).rejects.toThrow(/symbol/)
})

test('readBasket skips zero-balance tokens', async () => {
  const client = fakeClient({ tokens: { [WXDAI]: { symbol: 'WXDAI', decimals: 18, balance: 0n } } })
  const basket = await readBasket(client, {
    depositContract: '0xB53e4a513C1fbb11a66Da851643126D933489C4D',
    payoutTokens: [{ symbol: 'WXDAI', address: WXDAI }],
  })
  expect(basket).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd offchain && bun test treasury-basket.test.ts`
Expected: FAIL — cannot find module `./treasury-basket` / `readBasket` undefined.

- [ ] **Step 3: Implement `treasury-basket.ts`**

Create `offchain/treasury-basket.ts`:

```ts
// Production, fork-free basket reader. Reads the redemption Safe's live payout-token balances on real
// Gnosis chain and emits basket.json = [{ token, symbol, total }] — the exact shape fetch-deposits.ts
// consumes. The Safe is derived from the deposit contract's safe() immutable, never hand-typed. Deposit
// tokens (GNO/osGNO) are refused: paying them out would return depositors their own stake.
//
// Usage: bun treasury-basket.ts [out=basket.json] [--basket-block N]
// Env:   GNOSIS_RPC (real Gnosis RPC; default public). Reads at --basket-block or the finalized head.
import { createPublicClient, http, getAddress, erc20Abi, type Address } from 'viem'
import { gnosis } from 'viem/chains'
import { writeFileSync } from 'node:fs'
import { config, MAX_PAYOUT_TOKENS, type PayoutToken } from './config'

export type BasketAsset = { token: string; symbol: string; total: string }

export interface BasketReader {
  readContract(args: {
    address: string
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
    blockNumber?: bigint
  }): Promise<unknown>
}

const DEPOSIT_ABI = [
  { type: 'function', name: 'gno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'osgno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'safe', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

export async function readBasket(
  client: BasketReader,
  opts: { depositContract: string; payoutTokens: readonly PayoutToken[]; blockNumber?: bigint },
): Promise<BasketAsset[]> {
  const deposit = getAddress(opts.depositContract)
  const read = (functionName: 'gno' | 'osgno' | 'safe') =>
    client.readContract({ address: deposit, abi: DEPOSIT_ABI, functionName, blockNumber: opts.blockNumber })
  const [gnoRaw, osgnoRaw, safeRaw] = (await Promise.all([read('gno'), read('osgno'), read('safe')])) as [
    string,
    string,
    string,
  ]
  const safe = getAddress(safeRaw)
  const excluded = new Set([getAddress(gnoRaw).toLowerCase(), getAddress(osgnoRaw).toLowerCase()])

  const basket: BasketAsset[] = []
  for (const c of opts.payoutTokens) {
    const token = getAddress(c.address)
    if (excluded.has(token.toLowerCase()))
      throw new Error(`${c.symbol} (${token}) is a deposit token — remove it from payoutTokens`)

    const [symbol, , balance] = (await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol', blockNumber: opts.blockNumber }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals', blockNumber: opts.blockNumber }),
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [safe],
        blockNumber: opts.blockNumber,
      }),
    ])) as [string, number, bigint]
    if (symbol !== c.symbol) throw new Error(`${token}: on-chain symbol "${symbol}" != config symbol "${c.symbol}"`)
    if (balance === 0n) continue
    basket.push({ token, symbol, total: balance.toString() })
  }

  if (basket.length === 0)
    throw new Error(`empty basket — the Safe holds none of config.json's payoutTokens`)
  if (basket.length > MAX_PAYOUT_TOKENS) throw new Error(`basket has ${basket.length} tokens > ${MAX_PAYOUT_TOKENS}`)
  return basket
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const positional: string[] = []
  let blockNumber: bigint | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--basket-block') blockNumber = BigInt(args[++i])
    else positional.push(args[i])
  }
  const [outPath = 'basket.json'] = positional

  const RPC = process.env.GNOSIS_RPC ?? 'https://rpc.gnosischain.com'
  const client = createPublicClient({ chain: gnosis, transport: http(RPC) })
  if (blockNumber === undefined) blockNumber = (await client.getBlock({ blockTag: 'finalized' })).number

  const basket = await readBasket(client as unknown as BasketReader, {
    depositContract: config.depositContract,
    payoutTokens: config.payoutTokens,
    blockNumber,
  })
  writeFileSync(outPath, JSON.stringify(basket, null, 2))
  console.log(`basket @ block ${blockNumber} · ${basket.length} assets (${basket.map((b) => b.symbol).join(', ')})`)
  console.log(`wrote ${outPath} — next: bun fetch-deposits.ts <deposit> ${outPath} --to-block N`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd offchain && bun test treasury-basket.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add package.json script**

In `offchain/package.json`, add to `scripts`:
```json
"treasury-basket": "bun treasury-basket.ts",
"test": "bun test"
```

- [ ] **Step 6: Commit**

```bash
git add offchain/treasury-basket.ts offchain/treasury-basket.test.ts offchain/package.json
git commit -m "Add fork-free real-chain basket reader (treasury-basket.ts)"
```

---

### Task 3: Claim-for-all relayer `claim-all.ts`

Iterate the `build-merkle` manifest and submit `claim()` for every un-claimed holder from a relayer key. Abort if the distributor is not `activated`; simulate each claim before broadcast; `--dry-run` broadcasts nothing; re-runs skip already-claimed holders. Split the pure selection logic out for unit testing.

**Files:**
- Create: `offchain/claim-all.ts`
- Create: `offchain/claim-all.test.ts`
- Modify: `offchain/package.json` (scripts)

**Interfaces:**
- Consumes: nothing from other tasks (reads a manifest file matching `build-merkle`'s output).
- Produces:
  - `export type ManifestEntry = { holder: string; amounts: string[]; proof: string[] }`
  - `export type Manifest = { root: string; payoutTokens: string[]; manifest: ManifestEntry[] }`
  - `export function selectUnclaimed(entries: readonly ManifestEntry[], claimed: readonly boolean[]): ManifestEntry[]`
  - `export const DISTRIBUTOR_ABI` (viem-style const ABI with `activated`, `hasClaimed`, `claim`)

- [ ] **Step 1: Write the failing test**

Create `offchain/claim-all.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { selectUnclaimed, type ManifestEntry } from './claim-all'

const e = (holder: string): ManifestEntry => ({ holder, amounts: ['1'], proof: ['0x00'] })

test('selectUnclaimed keeps only holders whose claimed flag is false', () => {
  const entries = [e('0xa0'), e('0xa1'), e('0xa2')]
  const out = selectUnclaimed(entries, [false, true, false])
  expect(out.map((x) => x.holder)).toEqual(['0xa0', '0xa2'])
})

test('selectUnclaimed returns nothing when all are claimed', () => {
  const entries = [e('0xa0'), e('0xa1')]
  expect(selectUnclaimed(entries, [true, true])).toEqual([])
})

test('selectUnclaimed throws on a length mismatch (guards a mis-aligned read)', () => {
  expect(() => selectUnclaimed([e('0xa0')], [false, false])).toThrow(/length/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd offchain && bun test claim-all.test.ts`
Expected: FAIL — cannot find module `./claim-all`.

- [ ] **Step 3: Implement `claim-all.ts`**

Create `offchain/claim-all.ts`:

```ts
// Submit claim() for every un-claimed holder in a build-merkle manifest, from a relayer key. claim() is
// permissionless and always pays `account`, so the relayer never takes custody. Resumable + idempotent:
// a re-run skips already-claimed holders; a holder whose leg reverts is left for later, never dropped.
//
// Usage: bun claim-all.ts <manifest.json> [--dry-run]
// Env:   DISTRIBUTOR (distributor address), GNOSIS_RPC (real RPC), PRIVATE_KEY (relayer, 0x-hex).
import { createPublicClient, createWalletClient, http, getAddress, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { gnosis } from 'viem/chains'
import { readFileSync } from 'node:fs'

export type ManifestEntry = { holder: string; amounts: string[]; proof: string[] }
export type Manifest = { root: string; payoutTokens: string[]; manifest: ManifestEntry[] }

export const DISTRIBUTOR_ABI = [
  { type: 'function', name: 'activated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    type: 'function',
    name: 'hasClaimed',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256[]' }, { type: 'bytes32[]' }],
    outputs: [],
  },
] as const

export function selectUnclaimed(entries: readonly ManifestEntry[], claimed: readonly boolean[]): ManifestEntry[] {
  if (entries.length !== claimed.length)
    throw new Error(`length mismatch: ${entries.length} entries vs ${claimed.length} claimed flags`)
  return entries.filter((_, i) => !claimed[i])
}

function loadManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  if (!Array.isArray(m.manifest) || m.manifest.length === 0) throw new Error(`${path}: manifest is empty`)
  return m
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const manifestPath = args.find((a) => !a.startsWith('--'))
  if (!manifestPath) {
    console.error('usage: bun claim-all.ts <manifest.json> [--dry-run]')
    process.exit(1)
  }
  const distributor = getAddress(process.env.DISTRIBUTOR ?? '')
  const RPC = process.env.GNOSIS_RPC ?? 'https://rpc.gnosischain.com'
  const key = process.env.PRIVATE_KEY
  if (!key) throw new Error('PRIVATE_KEY required (relayer)')

  const account = privateKeyToAccount(key as `0x${string}`)
  const pub = createPublicClient({ chain: gnosis, transport: http(RPC) })
  const wallet = createWalletClient({ account, chain: gnosis, transport: http(RPC) })

  const { manifest } = loadManifest(manifestPath)

  const activated = (await pub.readContract({
    address: distributor,
    abi: DISTRIBUTOR_ABI,
    functionName: 'activated',
  })) as boolean
  if (!activated) throw new Error(`distributor ${distributor} is not activated — refusing to claim`)

  const claimed = (await Promise.all(
    manifest.map((m) =>
      pub.readContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'hasClaimed', args: [getAddress(m.holder)] }),
    ),
  )) as boolean[]
  const todo = selectUnclaimed(manifest, claimed)
  console.log(`${manifest.length} holders · ${manifest.length - todo.length} already claimed · ${todo.length} to claim${dryRun ? ' (dry-run)' : ''}`)

  let ok = 0
  let failed = 0
  for (const entry of todo) {
    const holder = getAddress(entry.holder)
    const claimArgs = [holder, entry.amounts.map(BigInt), entry.proof as `0x${string}`[]] as const
    try {
      await pub.simulateContract({ account, address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'claim', args: claimArgs })
    } catch (err) {
      failed++
      console.error(`  SKIP ${holder} — simulation reverted: ${(err as Error).message.split('\n')[0]}`)
      continue
    }
    if (dryRun) {
      ok++
      console.log(`  OK(sim) ${holder}`)
      continue
    }
    const hash = await wallet.writeContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'claim', args: claimArgs })
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status === 'success') {
      ok++
      console.log(`  OK ${holder} — ${hash}`)
    } else {
      failed++
      console.error(`  FAIL ${holder} — reverted ${hash}`)
    }
  }
  console.log(`done: ${ok} ${dryRun ? 'simulated' : 'claimed'}, ${failed} failed/skipped`)
  if (failed > 0) process.exitCode = 1
}

if (import.meta.main) await main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd offchain && bun test claim-all.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the module compiles**

Run: `cd offchain && bun build claim-all.ts --target=node > /dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 6: Add package.json script**

In `offchain/package.json` `scripts`, add:
```json
"claim-all": "bun claim-all.ts"
```

- [ ] **Step 7: Commit**

```bash
git add offchain/claim-all.ts offchain/claim-all.test.ts offchain/package.json
git commit -m "Add claim-all relayer (claims for every un-claimed holder)"
```

---

### Task 4: End-to-end test — `claim-all.ts` drains a live distributor on Anvil

Prove the relayer against a real deployed distributor on a fresh Anvil node: deploy a test-only `MockERC20` (×2) and the real `RedemptionDistributor` from compiled artifacts, fund + approve a Safe account, `activate()`, then run `claim-all`'s `main` and assert every holder is paid and the run is resumable and `--dry-run` is side-effect-free.

**Files:**
- Create: `contracts/test/mocks/MockERC20.sol` (test-only, standalone — compiled to an artifact the TS test deploys)
- Create: `offchain/claim-all.e2e.test.ts`

**Interfaces:**
- Consumes: `build` from `./build-merkle`; `DISTRIBUTOR_ABI` from `./claim-all`; compiled artifacts `../contracts/out/RedemptionDistributor.sol/RedemptionDistributor.json` and `../contracts/out/MockERC20.sol/MockERC20.json`.
- Produces: nothing (terminal test).

- [ ] **Step 1: Create the standalone mock and build artifacts**

Create `contracts/test/mocks/MockERC20.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test-only ERC20 with mint/approve/transferFrom — used by the claim-all e2e to stand in for basket tokens.
contract MockERC20 {
    string public symbol;
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_) {
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
```

Ensure Foundry deps are installed, then build so `out/` artifacts exist:

Run: `cd contracts && make install-contract-deps && forge build`
Expected: compiles; `contracts/out/RedemptionDistributor.sol/RedemptionDistributor.json` and `contracts/out/MockERC20.sol/MockERC20.json` exist.

- [ ] **Step 2: Confirm the existing Foundry suite is still green (mock is additive)**

Run: `cd contracts && forge test 2>&1 | tail -5`
Expected: all tests pass (the new standalone mock does not affect existing tests).

- [ ] **Step 3: Write the e2e test**

Create `offchain/claim-all.e2e.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  parseEther,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { build } from './build-merkle'
import { DISTRIBUTOR_ABI } from './claim-all'

// Anvil account #0 (well-known dev key). Acts as deployer, Safe (holds+approves), and relayer.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const RPC = 'http://127.0.0.1:8545'
const account = privateKeyToAccount(KEY)
const safe = account.address

// Three arbitrary holders — claim() pays `account`, so they need no keys.
const HOLDERS = [
  getAddress('0x00000000000000000000000000000000000000a1'),
  getAddress('0x00000000000000000000000000000000000000a2'),
  getAddress('0x00000000000000000000000000000000000000a3'),
]

let anvil: ReturnType<typeof Bun.spawn>
const pub = createPublicClient({ transport: http(RPC) })
const wallet = createWalletClient({ account, transport: http(RPC) })

function artifact(path: string): { abi: readonly unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(path, 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object as Hex }
}

async function deploy(art: { abi: readonly unknown[]; bytecode: Hex }, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account, chain: null })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error('no contractAddress')
  return receipt.contractAddress
}

beforeAll(async () => {
  anvil = Bun.spawn(['anvil', '--port', '8545', '--silent'], { stdout: 'ignore', stderr: 'ignore' })
  // Wait for the node to accept RPC.
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getBlockNumber()
      break
    } catch {
      await Bun.sleep(100)
    }
  }
})

afterAll(() => anvil?.kill())

test('claim-all pays every holder, is resumable, and dry-run is side-effect-free', async () => {
  const mock = artifact('../contracts/out/MockERC20.sol/MockERC20.json')
  const dist = artifact('../contracts/out/RedemptionDistributor.sol/RedemptionDistributor.json')

  // Two basket tokens.
  const tokenA = await deploy(mock, ['AAA'])
  const tokenB = await deploy(mock, ['BBB'])

  // Build the manifest off the same builder the production pipeline uses.
  const built = build({
    osgnoRate: parseEther('1').toString(),
    deposits: [
      { holder: HOLDERS[0], gno: '100', osgno: '0' },
      { holder: HOLDERS[1], gno: '200', osgno: '0' },
      { holder: HOLDERS[2], gno: '300', osgno: '0' },
    ],
    basket: [
      { token: tokenA, symbol: 'AAA', total: '600' },
      { token: tokenB, symbol: 'BBB', total: '60' },
    ],
  })

  // Deploy the real distributor; totals + safe come from the build output.
  const distributor = await deploy(dist, [
    built.root as Hex,
    built.payoutTokens.map((t) => getAddress(t)),
    built.payoutTotals.map(BigInt),
    safe,
  ])

  // Fund the Safe and approve the distributor for exactly the committed totals; activate.
  for (const [i, token] of [tokenA, tokenB].entries()) {
    await (await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: token, abi: mock.abi, functionName: 'mint', args: [safe, BigInt(built.payoutTotals[i])], account, chain: null }),
    }))
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: token, abi: mock.abi, functionName: 'approve', args: [distributor, BigInt(built.payoutTotals[i])], account, chain: null }),
    })
  }
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ address: distributor, abi: dist.abi, functionName: 'activate', args: [], account, chain: null }),
  })

  // Write the manifest file claim-all reads, and point its env at this node.
  const manifestPath = '/tmp/claim-all-e2e-manifest.json'
  writeFileSync(manifestPath, JSON.stringify(built, null, 2))
  process.env.DISTRIBUTOR = distributor
  process.env.GNOSIS_RPC = RPC
  process.env.PRIVATE_KEY = KEY

  const runMain = async (extra: string[]) => {
    const argv = process.argv
    process.argv = ['bun', 'claim-all.ts', manifestPath, ...extra]
    // Re-import with a cache-buster so main() re-runs its import.meta.main body.
    await import(`./claim-all?e2e=${Math.random()}`)
    process.argv = argv
  }

  // Dry-run: nothing should change on-chain.
  await runMain(['--dry-run'])
  for (const h of HOLDERS) {
    expect(await pub.readContract({ address: distributor, abi: dist.abi, functionName: 'hasClaimed', args: [h] })).toBe(false)
  }

  // Real run: everyone gets paid.
  await runMain([])
  for (const [i, h] of HOLDERS.entries()) {
    expect(await pub.readContract({ address: distributor, abi: dist.abi, functionName: 'hasClaimed', args: [h] })).toBe(true)
    const balA = (await pub.readContract({ address: tokenA, abi: mock.abi, functionName: 'balanceOf', args: [h] })) as bigint
    expect(balA).toBe(BigInt(built.manifest[i].amounts[0]))
  }
  // Safe drained to committed totals (dust — flooring remainder — never entered the basket).
  expect((await pub.readContract({ address: tokenA, abi: mock.abi, functionName: 'balanceOf', args: [safe] })) as bigint).toBe(0n)

  // Resumable: a second run claims nothing new (all hasClaimed).
  await runMain([])
  for (const h of HOLDERS) {
    expect(await pub.readContract({ address: distributor, abi: dist.abi, functionName: 'hasClaimed', args: [h] })).toBe(true)
  }
}, 60_000)
```

Note: `main()` calls `process.exit(1)` only on a missing arg, and sets `process.exitCode` (not `exit`) on claim failures — so importing it inside the test will not tear down the test runner. The cache-buster query on the dynamic import forces `import.meta.main` to re-evaluate per run.

- [ ] **Step 4: Run the e2e**

Run: `cd offchain && bun test claim-all.e2e.test.ts`
Expected: PASS (1 test) — dry-run leaves `hasClaimed=false`, real run pays all three holders their `amounts[0]` of tokenA and drains the Safe, second run is a no-op.

- [ ] **Step 5: Run the whole offchain suite**

Run: `cd offchain && bun test 2>&1 | tail -15`
Expected: all tests pass (Task 1–4 files).

- [ ] **Step 6: Commit**

```bash
git add contracts/test/mocks/MockERC20.sol offchain/claim-all.e2e.test.ts
git commit -m "Test claim-all end-to-end against a live distributor on Anvil"
```

---

### Task 5: Wire the production runbook into the README

Document the fork-free production sequence so an operator runs the right commands in the right order. Update `offchain/README`-level guidance (the `package.json` `preview` script stays; add the production path).

**Files:**
- Modify: `docs/ARCHITECTURE.md` (Off-chain pipeline section, lines ~98-121)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the off-chain pipeline docs**

In `docs/ARCHITECTURE.md`, in the "Off-chain Merkle pipeline" section, add `treasury-basket.ts` and `claim-all.ts` to the described flow and state that the production basket now comes from a live Gnosis read (not a Tenderly fork), and that `Deposited` logs are fetched over HyperRPC with the reconciliation guard unchanged. Add a short "Claiming for holders" note describing `claim-all.ts` (permissionless, resumable, `--dry-run`). Keep `treasury-nav.ts` described as the preview-only fork tool. Match the existing prose style; do not restructure the document.

- [ ] **Step 2: Verify no stale claims remain**

Run: `grep -n "fork" docs/ARCHITECTURE.md`
Expected: the only remaining fork references describe `treasury-nav.ts`/`preview-deposits.ts` as preview tooling, not the root-safe path.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "Document the fork-free production build + claim-all runbook"
```

---

## Self-Review

**Spec coverage:**
- Real-chain basket reader → Task 2. ✓
- HyperRPC log migration → Task 1. ✓
- claim-all relayer (resumable, dry-run, activated gate) → Task 3. ✓
- Tests: claim-all e2e (Anvil) → Task 4; treasury-basket unit → Task 2; fetch-deposits transport unit → Task 1. ✓
- No Solidity source changes; `treasury-nav.ts` retained → honored (only a test-only mock added, Task 4). ✓
- Docs/runbook → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output.

**Type consistency:** `selectUnclaimed(entries, claimed)`, `DISTRIBUTOR_ABI`, `readBasket(client, opts)`, `BasketAsset`, `pickLogRpc(env)` are used with the same names/shapes in their tasks and the e2e. `build()`'s output (`root`, `payoutTokens`, `payoutTotals`, `manifest[].amounts`) matches `build-merkle.ts` exactly.

**Notes for the implementer:**
- The e2e uses sequential `hasClaimed` reads (not Multicall3) so it runs on a fresh Anvil with no Multicall3 predeploy — this matches `claim-all.ts`, which also reads sequentially.
- If `bun build --target=node` is unavailable in your Bun version, substitute `bun run --check` or simply skip the compile-only sanity step; the unit tests already import the module.
