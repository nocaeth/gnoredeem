// Loads + validates config.json, the single place the redemption pipeline's deployment constants
// live. Every field is checked here so a typo fails at startup with a clear message rather than
// halfway through a build, or — worse — silently producing a wrong root.
//
// Point at a different file with CONFIG=<path> (e.g. a production config alongside the preview one).
import { getAddress, type Address } from 'viem'
import { readFileSync } from 'node:fs'

// Mirrors RedemptionDistributor.MAX_PAYOUT_TOKENS / build-merkle.ts. claim() loops every payout token
// in one tx, so an oversized basket risks a gas-bricked claim.
export const MAX_PAYOUT_TOKENS = 10

export type PayoutToken = { symbol: string; address: Address }
export type Config = {
  chainId: number
  depositContract: Address
  deployBlock: bigint
  logStep: bigint
  payoutTokens: PayoutToken[]
}

const CONFIG_PATH = process.env.CONFIG ?? new URL('./config.json', import.meta.url).pathname

function fail(msg: string): never {
  throw new Error(`${CONFIG_PATH}: ${msg}`)
}

function loadConfig(): Config {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))

  if (typeof raw.chainId !== 'number') fail('chainId must be a number')
  if (typeof raw.depositContract !== 'string') fail('depositContract must be an address string')
  if (!/^\d+$/.test(String(raw.deployBlock))) fail('deployBlock must be a non-negative integer (string or number)')

  // LOG_STEP env wins — the same config is used against RPCs with different getLogs range caps.
  const logStep = BigInt(process.env.LOG_STEP ?? raw.logStep)
  if (logStep <= 0n) fail('logStep must be > 0')

  if (!Array.isArray(raw.payoutTokens) || raw.payoutTokens.length === 0)
    fail('payoutTokens must be a non-empty array — with none, there is nothing to distribute')
  if (raw.payoutTokens.length > MAX_PAYOUT_TOKENS)
    fail(`payoutTokens has ${raw.payoutTokens.length} entries > MAX_PAYOUT_TOKENS=${MAX_PAYOUT_TOKENS}`)

  const seen = new Set<string>()
  const payoutTokens: PayoutToken[] = raw.payoutTokens.map((t: unknown, i: number) => {
    const entry = t as { symbol?: unknown; address?: unknown }
    if (typeof entry.symbol !== 'string' || entry.symbol.length === 0)
      fail(`payoutTokens[${i}] missing symbol`)
    if (typeof entry.address !== 'string') fail(`payoutTokens[${i}] (${entry.symbol}) missing address`)

    // getAddress rejects a bad checksum AND normalizes casing, so a hand-typed address that is
    // subtly wrong fails here rather than reading as a zero balance later.
    let address: Address
    try {
      address = getAddress(entry.address)
    } catch {
      return fail(`payoutTokens[${i}] (${entry.symbol}): "${entry.address}" is not a valid address`)
    }

    // A duplicate would double-count that token's Safe balance across two basket legs, committing the
    // distributor to pay out more than it can ever hold — activate() would revert and every claim
    // would be permanently unfundable.
    if (seen.has(address.toLowerCase())) fail(`duplicate payout token ${address} (${entry.symbol})`)
    seen.add(address.toLowerCase())

    return { symbol: entry.symbol, address }
  })

  return {
    chainId: raw.chainId,
    depositContract: getAddress(raw.depositContract),
    deployBlock: BigInt(raw.deployBlock),
    logStep,
    payoutTokens,
  }
}

export const config = loadConfig()
