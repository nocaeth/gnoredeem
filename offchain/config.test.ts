import { expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { config } from './config'

// The GIP-151 payout basket, verified on-chain (Gnosis) on 2026-07-17. This test pins the exact
// addresses/symbols/decimals so an accidental edit to config.json fails loudly rather than mis-paying.
const EXPECTED = [
  { symbol: 'wstETH', address: '0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6', decimals: 18 },
  { symbol: 'WXDAI', address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', decimals: 18 },
  { symbol: 'COW', address: '0x177127622c4A00F3d409B75571e12cB3c8973d3c', decimals: 18 },
  { symbol: 'SAFE', address: '0x4d18815D14fe5c3304e87B3FA18318baa5c23820', decimals: 18 },
  { symbol: 'HOPR', address: '0xD057604A14982FE8D88c5fC25Aac3267eA142a08', decimals: 18 },
  { symbol: 'PNK', address: '0x37b60f4E9A31A64cCc0024dce7D0fD07eAA0F7B3', decimals: 18 },
  { symbol: 'auraBAL', address: '0x63803B132a59E481920c4c46a981bF45555b0421', decimals: 18 },
]

// GNO / osGNO — deposit tokens, read from the deposit contract on-chain. Must never appear in the basket.
const GNO = getAddress('0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb')
const OSGNO = getAddress('0xF490c80aAE5f2616d3e3BDa2483E30C4CB21d1A0')

test('config pins the 7 verified Gnosis payout tokens', () => {
  expect(config.payoutTokens).toEqual(EXPECTED.map((t) => ({ symbol: t.symbol, address: getAddress(t.address), decimals: t.decimals })))
})

test('no deposit token (GNO/osGNO) is in the basket', () => {
  const banned = new Set([GNO, OSGNO])
  for (const t of config.payoutTokens) expect(banned.has(t.address)).toBe(false)
})

test('config targets the deposit contract on Gnosis', () => {
  expect(config.chainId).toBe(100)
  expect(config.depositContract).toBe(getAddress('0xB53e4a513C1fbb11a66Da851643126D933489C4D'))
})
