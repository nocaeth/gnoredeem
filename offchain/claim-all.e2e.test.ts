import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, getAddress, parseEther, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { gnosis } from 'viem/chains'
import { build } from './build-merkle'
import { main } from './claim-all'

// Anvil account #0 (well-known dev key). Acts as deployer, Safe (holds+approves), and relayer.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const RPC = 'http://127.0.0.1:8545'
const account = privateKeyToAccount(KEY)
const safe = account.address

// Three arbitrary holders — claim() pays `account`, so they need no keys.
const HOLDERS: Address[] = [
  getAddress('0x00000000000000000000000000000000000000a1'),
  getAddress('0x00000000000000000000000000000000000000a2'),
  getAddress('0x00000000000000000000000000000000000000a3'),
]

let anvil: ReturnType<typeof Bun.spawn>
// anvil runs with --chain-id 100 so it matches claim-all.ts's hardcoded gnosis clients.
const pub = createPublicClient({ chain: gnosis, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: gnosis, transport: http(RPC) })

function artifact(path: string): { abi: readonly unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(path, 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object as Hex }
}

async function deploy(art: { abi: readonly unknown[]; bytecode: Hex }, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error('no contractAddress')
  return receipt.contractAddress
}

async function send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
  const hash = await wallet.writeContract({ address, abi, functionName, args })
  return pub.waitForTransactionReceipt({ hash })
}

beforeAll(async () => {
  anvil = Bun.spawn(['anvil', '--port', '8545', '--chain-id', '100', '--silent'], { stdout: 'ignore', stderr: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getBlockNumber()
      return
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error('anvil did not become ready')
})

afterAll(() => anvil?.kill())

test('claim-all pays every holder, is resumable, and dry-run is side-effect-free', async () => {
  const mock = artifact('../contracts/out/MockERC20.sol/MockERC20.json')
  const dist = artifact('../contracts/out/RedemptionDistributor.sol/RedemptionDistributor.json')

  const tokenA = await deploy(mock, ['AAA'])
  const tokenB = await deploy(mock, ['BBB'])

  // Build the manifest off the same builder the production pipeline uses.
  const built = build({
    osgnoRate: parseEther('1').toString(),
    deposits: [
      { holder: HOLDERS[0], gno: '100', osgno: '0' },
      { holder: HOLDERS[1], gno: '200', osgno: '0' },
      { holder: HOLDERS[2], gno: '300', osgno: '0' },
    ],
    basket: [
      { token: tokenA, symbol: 'AAA', total: '600' },
      { token: tokenB, symbol: 'BBB', total: '60' },
    ],
  })

  const distributor = await deploy(dist, [
    built.root as Hex,
    built.payoutTokens.map((t) => getAddress(t)),
    built.payoutTotals.map(BigInt),
    safe,
  ])

  // Fund the Safe + approve the distributor for exactly the committed totals; activate.
  const tokens = [tokenA, tokenB]
  for (const [i, token] of tokens.entries()) {
    await send(token, mock.abi, 'mint', [safe, BigInt(built.payoutTotals[i])])
    await send(token, mock.abi, 'approve', [distributor, BigInt(built.payoutTotals[i])])
  }
  await send(distributor, dist.abi, 'activate', [])

  const manifestPath = '/tmp/claim-all-e2e-manifest.json'
  writeFileSync(manifestPath, JSON.stringify(built, null, 2))
  process.env.DISTRIBUTOR = distributor
  process.env.GNOSIS_RPC = RPC
  process.env.PRIVATE_KEY = KEY

  const runMain = async (extra: string[]) => {
    const saved = process.argv
    process.argv = ['bun', 'claim-all.ts', manifestPath, ...extra]
    try {
      await main()
    } finally {
      process.argv = saved
    }
  }

  const hasClaimed = (h: Address) =>
    pub.readContract({ address: distributor, abi: dist.abi, functionName: 'hasClaimed', args: [h] })
  const balanceOf = (token: Address, who: Address) =>
    pub.readContract({ address: token, abi: mock.abi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>

  // Dry-run: nothing changes on-chain.
  await runMain(['--dry-run'])
  for (const h of HOLDERS) expect(await hasClaimed(h)).toBe(false)

  // Real run: everyone gets paid their manifest amount of tokenA.
  await runMain([])
  for (const [i, h] of HOLDERS.entries()) {
    expect(await hasClaimed(h)).toBe(true)
    expect(await balanceOf(tokenA, h)).toBe(BigInt(built.manifest[i].amounts[0]))
  }
  // Safe drained to committed totals (flooring dust never entered the basket).
  expect(await balanceOf(tokenA, safe)).toBe(0n)

  // Resumable: a second run is a no-op.
  await runMain([])
  for (const h of HOLDERS) expect(await hasClaimed(h)).toBe(true)
}, 60_000)
