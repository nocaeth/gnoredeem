import { expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { verifyTokens } from './verify-tokens'
import type { BasketReader } from './treasury-basket'

const GNO = getAddress('0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb')
const OSGNO = getAddress('0xF490c80aAE5f2616d3e3BDa2483E30C4CB21d1A0')
const WSTETH = getAddress('0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6')
const DEPOSIT = '0xB53e4a513C1fbb11a66Da851643126D933489C4D'

function fakeClient(tokens: Record<string, { symbol: string; decimals: number } | 'not-erc20'>): BasketReader {
  return {
    async readContract({ address, functionName }) {
      const a = getAddress(address)
      if (a === getAddress(DEPOSIT)) {
        if (functionName === 'gno') return GNO
        if (functionName === 'osgno') return OSGNO
      }
      const t = tokens[a]
      if (t && t !== 'not-erc20') {
        if (functionName === 'symbol') return t.symbol
        if (functionName === 'decimals') return t.decimals
      }
      throw new Error(`execution reverted (${functionName} @ ${a})`)
    },
  }
}

test('verifyTokens returns a report when every token matches', async () => {
  const client = fakeClient({ [WSTETH]: { symbol: 'wstETH', decimals: 18 } })
  const report = await verifyTokens(client, {
    depositContract: DEPOSIT,
    payoutTokens: [{ symbol: 'wstETH', address: WSTETH, decimals: 18 }],
  })
  expect(report).toEqual([{ symbol: 'wstETH', address: WSTETH, decimals: 18 }])
})

test('verifyTokens throws on an on-chain symbol mismatch', async () => {
  const client = fakeClient({ [WSTETH]: { symbol: 'NOPE', decimals: 18 } })
  await expect(
    verifyTokens(client, { depositContract: DEPOSIT, payoutTokens: [{ symbol: 'wstETH', address: WSTETH, decimals: 18 }] }),
  ).rejects.toThrow(/symbol/)
})

test('verifyTokens throws on a decimals mismatch', async () => {
  const client = fakeClient({ [WSTETH]: { symbol: 'wstETH', decimals: 6 } })
  await expect(
    verifyTokens(client, { depositContract: DEPOSIT, payoutTokens: [{ symbol: 'wstETH', address: WSTETH, decimals: 18 }] }),
  ).rejects.toThrow(/decimals/)
})

test('verifyTokens rejects a deposit token (GNO) in the basket', async () => {
  const client = fakeClient({ [GNO]: { symbol: 'GNO', decimals: 18 } })
  await expect(
    verifyTokens(client, { depositContract: DEPOSIT, payoutTokens: [{ symbol: 'GNO', address: GNO, decimals: 18 }] }),
  ).rejects.toThrow(/deposit token/)
})

test('verifyTokens throws when an address is not an ERC20', async () => {
  const client = fakeClient({ [WSTETH]: 'not-erc20' })
  await expect(
    verifyTokens(client, { depositContract: DEPOSIT, payoutTokens: [{ symbol: 'wstETH', address: WSTETH, decimals: 18 }] }),
  ).rejects.toThrow(/did not respond as an ERC20|reverted/)
})

test('verifyTokens reports all problems at once', async () => {
  const client = fakeClient({
    [WSTETH]: { symbol: 'wstETH', decimals: 18 },
    [OSGNO]: { symbol: 'osGNO', decimals: 18 },
  })
  await expect(
    verifyTokens(client, {
      depositContract: DEPOSIT,
      payoutTokens: [
        { symbol: 'wstETH', address: WSTETH, decimals: 6 }, // wrong decimals
        { symbol: 'osGNO', address: OSGNO, decimals: 18 }, // deposit token
      ],
    }),
  ).rejects.toThrow(/decimals[\s\S]*deposit token|deposit token[\s\S]*decimals/)
})
