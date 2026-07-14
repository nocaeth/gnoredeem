// PREVIEW ONLY — bypasses deadline + finality gates from fetch-deposits.ts.
// Window may still be open; deposits can change. DO NOT build the root from this.
//
// Deposit contract + scan range come from config.json (see config.ts).
//
// Usage: bun preview-deposits.ts [out=preview-deposits.json]
import { createPublicClient, http, parseAbiItem, type Address, type Log } from 'viem'
import { gnosis } from 'viem/chains'
import { writeFileSync } from 'node:fs'
import { config } from './config'

const HYPERRPC =
  process.env.HYPERRPC ??
  (process.env.ENVIO_API_KEY ? `https://100.rpc.hypersync.xyz/${process.env.ENVIO_API_KEY}` : undefined)
const PUBLIC_RPC = process.env.PUBLIC_RPC ?? 'https://rpc.gnosischain.com'
const DEPLOY_BLOCK = config.deployBlock
const DEPOSITED = parseAbiItem(
  'event Deposited(address indexed holder, address indexed token, uint256 amount)',
)
const VIEW_ABI = [
  { type: 'function', name: 'gno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'osgno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'osgnoRate', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'deadline', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'totalDeposited',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const [outPath = 'preview-deposits.json'] = process.argv.slice(2)

const logClient = HYPERRPC ? createPublicClient({ chain: gnosis, transport: http(HYPERRPC) }) : null
if (!logClient) console.error('warning: HYPERRPC unset — falling back to public RPC for getLogs (slow)')
const callClient = createPublicClient({ chain: gnosis, transport: http(PUBLIC_RPC) })
const deposit = config.depositContract

const latest = await callClient.getBlock({ blockTag: 'latest' })
const toBlock = latest.number
const [gno, osgno, osgnoRate, deadline] = (await Promise.all([
  callClient.readContract({ address: deposit, abi: VIEW_ABI, functionName: 'gno' }),
  callClient.readContract({ address: deposit, abi: VIEW_ABI, functionName: 'osgno' }),
  callClient.readContract({ address: deposit, abi: VIEW_ABI, functionName: 'osgnoRate' }),
  callClient.readContract({ address: deposit, abi: VIEW_ABI, functionName: 'deadline' }),
])) as [Address, Address, bigint, bigint]

console.log(`NOTE: preview at latest block ${toBlock} (ts ${latest.timestamp}). deadline ${deadline}. NOT final, NOT root-safe.`)
const pastDeadline = latest.timestamp > deadline
if (!pastDeadline) {
  console.log(`window OPEN — block ts ${latest.timestamp} <= deadline ${deadline}. deposits still accepted.`)
}

const STEP = config.logStep
const logs: Log<bigint, number, false, typeof DEPOSITED>[] = []
const getLogsClient = logClient ?? callClient
for (let start = DEPLOY_BLOCK; start <= toBlock; start += STEP) {
  const end = start + STEP - 1n < toBlock ? start + STEP - 1n : toBlock
  const chunk = await getLogsClient.getLogs({ address: deposit, event: DEPOSITED, fromBlock: start, toBlock: end })
  logs.push(...chunk)
}

const gnoL = (gno as string).toLowerCase()
const osgnoL = (osgno as string).toLowerCase()
const agg = new Map<string, { gno: bigint; osgno: bigint }>()
for (const l of logs) {
  const holder = (l.args.holder as string).toLowerCase()
  const token = (l.args.token as string).toLowerCase()
  const amount = l.args.amount as bigint
  const e = agg.get(holder) ?? { gno: 0n, osgno: 0n }
  if (token === gnoL) e.gno += amount
  else if (token === osgnoL) e.osgno += amount
  else throw new Error(`unexpected token ${token}`)
  agg.set(holder, e)
}

const deposits = [...agg.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([holder, v]) => ({ holder, gno: v.gno.toString(), osgno: v.osgno.toString() }))

const [onchainGno, onchainOsgno] = (await Promise.all([
  callClient.readContract({ address: deposit, abi: VIEW_ABI, functionName: 'totalDeposited', args: [gno], blockNumber: toBlock }),
  callClient.readContract({ address: deposit, abi: VIEW_ABI, functionName: 'totalDeposited', args: [osgno], blockNumber: toBlock }),
])) as [bigint, bigint]
const sumGno = deposits.reduce((s, d) => s + BigInt(d.gno), 0n)
const sumOsgno = deposits.reduce((s, d) => s + BigInt(d.osgno), 0n)
if (sumGno !== onchainGno) throw new Error(`GNO mismatch: events ${sumGno} vs on-chain ${onchainGno} at ${toBlock}`)
if (sumOsgno !== onchainOsgno) throw new Error(`osGNO mismatch: events ${sumOsgno} vs on-chain ${onchainOsgno} at ${toBlock}`)

const out = {
  osgnoRate: osgnoRate.toString(),
  meta: {
    depositContract: deposit,
    gno,
    osgno,
    osgnoRate: osgnoRate.toString(),
    deadline: deadline.toString(),
    toBlock: toBlock.toString(),
    toBlockHash: latest.hash,
    toBlockTimestamp: latest.timestamp.toString(),
    pastDeadline,
    eventCount: logs.length,
    holderCount: deposits.length,
    totalDeposited: { gno: onchainGno.toString(), osgno: onchainOsgno.toString() },
  },
  deposits,
}
writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log(`wrote ${outPath} — ${deposits.length} holders, ${logs.length} events, block ${toBlock}`)
console.log(`totals: GNO ${sumGno}, osGNO ${sumOsgno} (reconciled)`)
