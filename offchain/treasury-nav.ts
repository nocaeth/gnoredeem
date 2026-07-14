// PREVIEW ONLY — reads the redemption Safe's holdings on a Gnosis fork (tenderly virtual RPC) and
// emits a build-config for build-merkle.ts.
//
// Payout model: the Safe is funded with EXACTLY the amounts to distribute, so its whole balance of
// each payout token IS the basket. build-merkle then splits each basket asset between depositors by
// their share of the total deposit stake:
//
//   weight(holder) = rawGno + rawOsgno * osgnoRate / 1e18        (floored once per holder)
//   alloc(holder)  = balance * weight / sum(weights)             (floor; dust stays in the Safe)
//
// There is no NAV/supply term — GNO totalSupply is irrelevant here. Whatever sits in the Safe gets
// divided among depositors, pro-rata to what they deposited.
//
// GNO/osGNO are excluded from the basket: the Safe holds them because the deposit contract forwards
// every deposit to it, so they ARE the deposits, not the proceeds. Paying them out would return
// depositors their own stake.
//
// TRUST BOUNDARY: the basket is drawn from config.json's payoutTokens. A token the Safe holds but
// that is NOT listed there is paid out to nobody — it stays in the Safe and depositors are
// under-paid. An address cannot be asked for its ERC20s over plain RPC (a fork funded by storage
// override emits no Transfer log to discover from), so that list IS the trust boundary. Every entry
// is verified against chain here: a wrong address throws, a wrong symbol throws.
//
// Usage: bun treasury-nav.ts <preview-deposits.json> [out=build-config.json]
//
// Env:
//   TREASURY_RPC (required) — tenderly virtual/fork JSON-RPC URL. Every read (safe, balances) comes
//                             from here, so the basket is one coherent snapshot.
import { createPublicClient, http, getAddress, erc20Abi, type Address } from 'viem'
import { readFileSync, writeFileSync } from 'node:fs'
import { config, MAX_PAYOUT_TOKENS } from './config'

const TREASURY_RPC = process.env.TREASURY_RPC
if (!TREASURY_RPC) {
  console.error('TREASURY_RPC required (tenderly fork URL)')
  process.exit(1)
}

const [inPath, outPath = 'build-config.json'] = process.argv.slice(2)
if (!inPath) {
  console.error('usage: bun treasury-nav.ts <preview-deposits.json> [out.json]')
  process.exit(1)
}

// No `chain` — the virtual testnet reports chainId 999100, not 100, and asserting gnosis here would
// be a lie. Nothing we call is chain-id dependent.
const fork = createPublicClient({ transport: http(TREASURY_RPC) })

const ONE = 10n ** 18n

const DEPOSIT_ABI = [
  { type: 'function', name: 'gno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'osgno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'osgnoRate', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'safe', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

type Preview = {
  osgnoRate?: string
  deposits?: { holder: string; gno: string; osgno: string }[]
  meta?: { depositContract?: string; [k: string]: unknown }
}
const preview = JSON.parse(readFileSync(inPath, 'utf8')) as Preview
if (!preview.osgnoRate) throw new Error(`${inPath} missing osgnoRate — re-run preview-deposits.ts`)
if (!preview.deposits?.length) throw new Error(`${inPath} missing deposits`)
const depositContract = preview.meta?.depositContract
if (!depositContract) throw new Error(`${inPath} missing meta.depositContract`)

// The deposits must have been fetched from the contract this config targets. Otherwise a stale
// preview file would be merged with a basket read from a different deployment's Safe.
if (getAddress(depositContract) !== config.depositContract)
  throw new Error(
    `${inPath} was built from deposit contract ${depositContract}, but config.json targets ${config.depositContract} — re-run preview-deposits.ts`,
  )

// Read the deposit contract's immutables from the SAME fork the balances come from. The Safe is
// derived, never typed by hand — an operator cannot point the basket at the wrong Safe.
const deposit = getAddress(depositContract)
const [gno, osgno, rate, safe] = (await Promise.all([
  fork.readContract({ address: deposit, abi: DEPOSIT_ABI, functionName: 'gno' }),
  fork.readContract({ address: deposit, abi: DEPOSIT_ABI, functionName: 'osgno' }),
  fork.readContract({ address: deposit, abi: DEPOSIT_ABI, functionName: 'osgnoRate' }),
  fork.readContract({ address: deposit, abi: DEPOSIT_ABI, functionName: 'safe' }),
])) as [Address, Address, bigint, Address]

// The rate the config carries must be the chain's — build-merkle weights osGNO with it.
if (BigInt(preview.osgnoRate) !== rate)
  throw new Error(`osgnoRate mismatch: preview ${preview.osgnoRate} vs on-chain ${rate} — re-run preview-deposits.ts`)

const block = await fork.getBlockNumber()
console.log(`fork block ${block} · deposit ${deposit} · safe ${safe}`)
console.log(`osgnoRate ${rate} (${Number(rate) / 1e18})`)

// Total deposit stake — floored per holder exactly as build-merkle does, so the per-GNO figures
// printed here are the ones the tree will actually pay.
const rawGno = new Map<string, bigint>()
const rawOsgno = new Map<string, bigint>()
for (const d of preview.deposits) {
  const h = getAddress(d.holder).toLowerCase()
  rawGno.set(h, (rawGno.get(h) ?? 0n) + BigInt(d.gno))
  rawOsgno.set(h, (rawOsgno.get(h) ?? 0n) + BigInt(d.osgno))
}
let totalStake = 0n
for (const h of new Set([...rawGno.keys(), ...rawOsgno.keys()])) {
  totalStake += (rawGno.get(h) ?? 0n) + ((rawOsgno.get(h) ?? 0n) * rate) / ONE
}
if (totalStake === 0n) throw new Error('total deposit stake is zero — no eligible deposits')
console.log(`deposit stake = ${fmt(totalStake, 18)} GNO-equiv across ${rawGno.size} holders\n`)

// --- basket: the Safe's full balance of each payout token ---------------------------------------
const excluded = new Set([gno.toLowerCase(), osgno.toLowerCase()])
const basket: { token: string; symbol: string; total: string }[] = []

for (const c of config.payoutTokens) {
  const token = c.address
  // Listing GNO/osGNO would pay depositors back their own stake — a config error, not something to
  // quietly skip over.
  if (excluded.has(token.toLowerCase()))
    throw new Error(`config.json lists ${c.symbol} (${token}) as a payout token, but it is the deposit token — remove it`)

  // Verify the address is the token it claims to be. A non-contract throws here; a real ERC20 with a
  // different symbol trips the assert. Either way the basket never silently loses a leg.
  const [symbol, decimals, balance] = (await Promise.all([
    fork.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    fork.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    fork.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [safe] }),
  ])) as [string, number, bigint]
  if (symbol !== c.symbol) throw new Error(`${token}: on-chain symbol "${symbol}" != config symbol "${c.symbol}"`)

  if (balance === 0n) {
    console.log(`  ${c.symbol.padEnd(7)} skip — zero balance`)
    continue
  }

  const perGno = (balance * ONE) / totalStake
  console.log(
    `  ${c.symbol.padEnd(7)} basket ${fmt(balance, decimals).padStart(16)} · ${fmt(perGno, decimals)} per GNO-equiv`,
  )
  basket.push({ token, symbol, total: balance.toString() })
}

if (basket.length === 0)
  throw new Error(`empty basket — the Safe holds none of config.json's payoutTokens (${config.payoutTokens.map((t) => t.symbol).join(', ')})`)
if (basket.length > MAX_PAYOUT_TOKENS)
  throw new Error(`basket has ${basket.length} tokens > MAX_PAYOUT_TOKENS=${MAX_PAYOUT_TOKENS}`)

const buildConfig = {
  osgnoRate: preview.osgnoRate,
  deposits: preview.deposits,
  basket,
  meta: {
    ...(preview.meta ?? {}),
    treasurySafe: safe,
    treasuryBlock: block.toString(),
    treasuryRpcHost: new URL(TREASURY_RPC).host,
    totalDepositStake: totalStake.toString(),
  },
}
writeFileSync(outPath, JSON.stringify(buildConfig, null, 2))
console.log(`\nwrote ${outPath} → next: bun build-merkle.ts ${outPath} merkle-preview.json`)
console.log('PREVIEW ONLY — fork state, window may still be open. NOT root-safe.')

function fmt(v: bigint, decimals: number): string {
  return (Number(v) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 4 })
}
