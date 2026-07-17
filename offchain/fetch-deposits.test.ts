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
