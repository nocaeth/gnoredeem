import { expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { readBasket, type BasketReader } from './treasury-basket'

const SAFE = getAddress('0x00000000000000000000000000000000000000ff')
const GNO = getAddress('0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb')
const OSGNO = getAddress('0xf490c80aAE5f2616d3e3BDa2483E30C4CB21d1A0')
const WXDAI = getAddress('0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d')
const DEPOSIT = '0xB53e4a513C1fbb11a66Da851643126D933489C4D'

// Fake client: routes (address, functionName) -> value. Unknown routes throw (fail-loud parity).
function fakeClient(spec: {
  safe?: string
  gno?: string
  osgno?: string
  tokens: Record<string, { symbol: string; decimals: number; balance: bigint }>
}): BasketReader {
  return {
    async readContract({ address, functionName }) {
      const a = getAddress(address)
      if (a === getAddress(DEPOSIT)) {
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
  const basket = await readBasket(client, { depositContract: DEPOSIT, payoutTokens: [{ symbol: 'WXDAI', address: WXDAI, decimals: 18 }] })
  expect(basket).toEqual([{ token: WXDAI, symbol: 'WXDAI', total: '1000' }])
})

test('readBasket throws when a payout token is a deposit token', async () => {
  const client = fakeClient({ tokens: { [GNO]: { symbol: 'GNO', decimals: 18, balance: 5n } } })
  await expect(
    readBasket(client, { depositContract: DEPOSIT, payoutTokens: [{ symbol: 'GNO', address: GNO, decimals: 18 }] }),
  ).rejects.toThrow(/deposit token/)
})

test('readBasket throws on an on-chain symbol mismatch', async () => {
  const client = fakeClient({ tokens: { [WXDAI]: { symbol: 'NOPE', decimals: 18, balance: 5n } } })
  await expect(
    readBasket(client, { depositContract: DEPOSIT, payoutTokens: [{ symbol: 'WXDAI', address: WXDAI, decimals: 18 }] }),
  ).rejects.toThrow(/symbol/)
})

const WETH = getAddress('0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1')

test('readBasket skips zero-balance tokens but keeps funded ones', async () => {
  const client = fakeClient({
    tokens: {
      [WXDAI]: { symbol: 'WXDAI', decimals: 18, balance: 0n },
      [WETH]: { symbol: 'WETH', decimals: 18, balance: 42n },
    },
  })
  const basket = await readBasket(client, {
    depositContract: DEPOSIT,
    payoutTokens: [
      { symbol: 'WXDAI', address: WXDAI, decimals: 18 },
      { symbol: 'WETH', address: WETH, decimals: 18 },
    ],
  })
  expect(basket).toEqual([{ token: WETH, symbol: 'WETH', total: '42' }])
})

test('readBasket throws when the whole basket is empty', async () => {
  const client = fakeClient({ tokens: { [WXDAI]: { symbol: 'WXDAI', decimals: 18, balance: 0n } } })
  await expect(
    readBasket(client, { depositContract: DEPOSIT, payoutTokens: [{ symbol: 'WXDAI', address: WXDAI, decimals: 18 }] }),
  ).rejects.toThrow(/empty basket/)
})
