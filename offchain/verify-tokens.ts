// Preflight validator: assert every config.json payout token is the exact token it claims to be on
// Gnosis chain, before any manifest is built or the Safe is funded. For each token it reads the live
// symbol + decimals and checks them against config; it also refuses any token equal to the deposit
// contract's gno()/osgno() immutables (paying those out would return depositors their own stake). A
// non-contract / non-ERC20 address reverts the read and is reported. Throws (non-zero exit) on ANY
// mismatch, listing every problem — never a partial pass.
//
// Usage: bun verify-tokens.ts
// Env:   GNOSIS_RPC (real Gnosis RPC; default public).
import { createPublicClient, http, getAddress, erc20Abi } from 'viem'
import { gnosis } from 'viem/chains'
import { config, type PayoutToken } from './config'
import type { BasketReader } from './treasury-basket'

const DEPOSIT_ABI = [
  { type: 'function', name: 'gno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'osgno', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

export type TokenReport = { symbol: string; address: string; decimals: number }

export async function verifyTokens(
  client: BasketReader,
  opts: { depositContract: string; payoutTokens: readonly PayoutToken[] },
): Promise<TokenReport[]> {
  const deposit = getAddress(opts.depositContract)
  const [gnoRaw, osgnoRaw] = (await Promise.all([
    client.readContract({ address: deposit, abi: DEPOSIT_ABI, functionName: 'gno' }),
    client.readContract({ address: deposit, abi: DEPOSIT_ABI, functionName: 'osgno' }),
  ])) as [string, string]
  const excluded = new Set([getAddress(gnoRaw).toLowerCase(), getAddress(osgnoRaw).toLowerCase()])

  const problems: string[] = []
  const report: TokenReport[] = []
  for (const t of opts.payoutTokens) {
    const addr = getAddress(t.address)
    if (excluded.has(addr.toLowerCase())) {
      problems.push(`${t.symbol} ${addr} is a deposit token (GNO/osGNO) — remove it from payoutTokens`)
      continue
    }
    let symbol: string
    let decimals: number
    try {
      ;[symbol, decimals] = (await Promise.all([
        client.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: addr, abi: erc20Abi, functionName: 'decimals' }),
      ])) as [string, number]
    } catch (err) {
      problems.push(`${t.symbol} ${addr} did not respond as an ERC20: ${(err as Error).message.split('\n')[0]}`)
      continue
    }
    if (symbol !== t.symbol) problems.push(`${addr}: on-chain symbol "${symbol}" != config symbol "${t.symbol}"`)
    if (Number(decimals) !== t.decimals)
      problems.push(`${t.symbol} ${addr}: on-chain decimals ${decimals} != config decimals ${t.decimals}`)
    report.push({ symbol, address: addr, decimals: Number(decimals) })
  }

  if (problems.length > 0) throw new Error(`token verification failed:\n  - ${problems.join('\n  - ')}`)
  return report
}

if (import.meta.main) {
  const RPC = process.env.GNOSIS_RPC ?? 'https://rpc.gnosischain.com'
  const client = createPublicClient({ chain: gnosis, transport: http(RPC) })
  const report = await verifyTokens(client as unknown as BasketReader, {
    depositContract: config.depositContract,
    payoutTokens: config.payoutTokens,
  })
  for (const r of report) console.log(`  OK  ${r.symbol.padEnd(8)} ${r.address}  decimals=${r.decimals}`)
  console.log(`verified ${report.length} payout tokens on Gnosis against config (${new URL(RPC).host})`)
}
