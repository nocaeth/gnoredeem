// Production, fork-free basket reader. Reads the redemption Safe's live payout-token balances on real
// Gnosis chain and emits basket.json = [{ token, symbol, total }] — the exact shape fetch-deposits.ts
// consumes. The Safe is derived from the deposit contract's safe() immutable, never hand-typed. Deposit
// tokens (GNO/osGNO) are refused: paying them out would return depositors their own stake.
//
// Usage: bun treasury-basket.ts [out=basket.json] [--basket-block N]
// Env:   GNOSIS_RPC (real Gnosis RPC; default public). Reads at --basket-block or the finalized head.
import { createPublicClient, http, getAddress, erc20Abi } from 'viem'
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

    const [symbol, decimals, balance] = (await Promise.all([
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
    if (Number(decimals) !== c.decimals)
      throw new Error(`${token} (${c.symbol}): on-chain decimals ${decimals} != config decimals ${c.decimals}`)
    if (balance === 0n) continue
    basket.push({ token, symbol, total: balance.toString() })
  }

  if (basket.length === 0) throw new Error(`empty basket — the Safe holds none of config.json's payoutTokens`)
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
