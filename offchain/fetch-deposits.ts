/**
 * Source the canonical deposit set + the FROZEN osGNO rate from the deployed RedemptionDeposit, merge
 * a basket file, and emit a ready-to-build config for build-merkle.ts. This makes the Merkle root
 * provably derived from on-chain state (Deposited events + the on-chain `osgnoRate()` immutable) rather
 * than a hand-assembled JSON — closing audit finding H3 (operator can't paste a wrong/stale rate, and
 * deposits are reconstructed from the chain, so anyone can reproduce the root).
 *
 * Usage:
 *   GNOSIS_RPC=<url> bun fetch-deposits.ts <depositContract> <basket.json> [out=build-config.json] \
 *       [--from-block N] [--to-block N]
 *
 *   basket.json = [{ "token": "0x..", "symbol": "USDC", "total": "<raw amount earmarked for redeemers>" }, ...]
 *
 * Then:  bun build-merkle.ts build-config.json out.json
 *        forge script script/DeployDistributor.s.sol  (reads out.json)
 */
import { createPublicClient, http, parseAbiItem, getAddress, type Address, type Log } from 'viem'
import { gnosis } from 'viem/chains'
import { readFileSync, writeFileSync } from 'node:fs'

const RPC = process.env.GNOSIS_RPC ?? process.env.VITE_GNOSIS_RPC ?? 'https://rpc.gnosischain.com'
const DEPOSITED = parseAbiItem(
  'event Deposited(address indexed holder, address indexed token, uint256 amount)',
)
const VIEW_ABI = [
  { type: 'function', name: 'gno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'osgno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'osgnoRate', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'deadline', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

// ── arg parsing ──────────────────────────────────────────────────────────────
const raw = process.argv.slice(2)
const positional: string[] = []
let fromBlock = 0n
let toBlockArg: bigint | undefined
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--from-block') fromBlock = BigInt(raw[++i])
  else if (raw[i] === '--to-block') toBlockArg = BigInt(raw[++i])
  else positional.push(raw[i])
}
const [contractArg, basketPath, outPath = 'build-config.json'] = positional
if (!contractArg || !basketPath) {
  console.error('usage: bun fetch-deposits.ts <depositContract> <basket.json> [out.json] [--from-block N] [--to-block N]')
  process.exit(1)
}

const client = createPublicClient({ chain: gnosis, transport: http(RPC) })
const deposit = getAddress(contractArg)

const read = (functionName: 'gno' | 'osgno' | 'osgnoRate' | 'deadline') =>
  client.readContract({ address: deposit, abi: VIEW_ABI, functionName })

const [gno, osgno, osgnoRate, deadline] = (await Promise.all([
  read('gno'),
  read('osgno'),
  read('osgnoRate'),
  read('deadline'),
])) as [Address, Address, bigint, bigint]

const toBlock = toBlockArg ?? (await client.getBlockNumber())

// Chunked log fetch — Gnosis public RPCs cap getLogs ranges; a single 240k-block window would be
// silently truncated, which would mis-build the root. Walk fixed windows so nothing is dropped.
const STEP = 10_000n
const logs: Log<bigint, number, false, typeof DEPOSITED>[] = []
for (let start = fromBlock; start <= toBlock; start += STEP) {
  const end = start + STEP - 1n < toBlock ? start + STEP - 1n : toBlock
  const chunk = await client.getLogs({ address: deposit, event: DEPOSITED, fromBlock: start, toBlock: end })
  logs.push(...chunk)
}

const gnoL = gno.toLowerCase()
const osgnoL = osgno.toLowerCase()
const agg = new Map<string, { gno: bigint; osgno: bigint }>()
for (const l of logs) {
  const holder = (l.args.holder as string).toLowerCase()
  const token = (l.args.token as string).toLowerCase()
  const amount = l.args.amount as bigint
  const e = agg.get(holder) ?? { gno: 0n, osgno: 0n }
  if (token === gnoL) e.gno += amount
  else if (token === osgnoL) e.osgno += amount
  else throw new Error(`Deposited event with unexpected token ${token} (not GNO/osGNO) — aborting`)
  agg.set(holder, e)
}

const deposits = [...agg.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([holder, v]) => ({ holder, gno: v.gno.toString(), osgno: v.osgno.toString() }))

const basket = JSON.parse(readFileSync(basketPath, 'utf8'))
if (!Array.isArray(basket)) throw new Error('basket file must be a JSON array of { token, symbol, total }')

const config = {
  osgnoRate: osgnoRate.toString(), // the deployed immutable — NOT a hand-typed value
  deposits,
  basket,
  meta: {
    depositContract: deposit,
    gno,
    osgno,
    deadline: deadline.toString(),
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    eventCount: logs.length,
    holderCount: deposits.length,
    rpc: RPC,
  },
}
writeFileSync(outPath, JSON.stringify(config, null, 2))

console.log(`osgnoRate (on-chain immutable): ${osgnoRate}`)
console.log(`deposits: ${deposits.length} holders from ${logs.length} events  [blocks ${fromBlock}..${toBlock}]`)
console.log(`basket:   ${basket.length} assets`)
console.log(`wrote ${outPath}  ->  next: bun build-merkle.ts ${outPath} out.json`)
