// Submit claim() for every un-claimed holder in a build-merkle manifest, from a relayer key. claim() is
// permissionless and always pays `account`, so the relayer never takes custody. Resumable + idempotent:
// a re-run skips already-claimed holders; a holder whose leg reverts is left for later, never dropped.
//
// Usage: bun claim-all.ts <manifest.json> [--dry-run]
// Env:   DISTRIBUTOR (distributor address), GNOSIS_RPC (real RPC), PRIVATE_KEY (relayer, 0x-hex).
import { createPublicClient, createWalletClient, http, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { gnosis } from 'viem/chains'
import { readFileSync } from 'node:fs'

export type ManifestEntry = { holder: string; amounts: string[]; proof: string[] }
export type Manifest = { root: string; payoutTokens: string[]; manifest: ManifestEntry[] }

export const DISTRIBUTOR_ABI = [
  { type: 'function', name: 'activated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    type: 'function',
    name: 'hasClaimed',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256[]' }, { type: 'bytes32[]' }],
    outputs: [],
  },
] as const

export function selectUnclaimed(entries: readonly ManifestEntry[], claimed: readonly boolean[]): ManifestEntry[] {
  if (entries.length !== claimed.length)
    throw new Error(`length mismatch: ${entries.length} entries vs ${claimed.length} claimed flags`)
  return entries.filter((_, i) => !claimed[i])
}

function loadManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  if (!Array.isArray(m.manifest) || m.manifest.length === 0) throw new Error(`${path}: manifest is empty`)
  return m
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const manifestPath = args.find((a) => !a.startsWith('--'))
  if (!manifestPath) {
    console.error('usage: bun claim-all.ts <manifest.json> [--dry-run]')
    process.exit(1)
  }
  const distributor = getAddress(process.env.DISTRIBUTOR ?? '')
  const RPC = process.env.GNOSIS_RPC ?? 'https://rpc.gnosischain.com'
  const key = process.env.PRIVATE_KEY
  if (!key) throw new Error('PRIVATE_KEY required (relayer)')

  const account = privateKeyToAccount(key as `0x${string}`)
  const pub = createPublicClient({ chain: gnosis, transport: http(RPC) })
  const wallet = createWalletClient({ account, chain: gnosis, transport: http(RPC) })

  const { manifest } = loadManifest(manifestPath)

  const activated = (await pub.readContract({
    address: distributor,
    abi: DISTRIBUTOR_ABI,
    functionName: 'activated',
  })) as boolean
  if (!activated) throw new Error(`distributor ${distributor} is not activated — refusing to claim`)

  const claimed = (await Promise.all(
    manifest.map((m) =>
      pub.readContract({
        address: distributor,
        abi: DISTRIBUTOR_ABI,
        functionName: 'hasClaimed',
        args: [getAddress(m.holder)],
      }),
    ),
  )) as boolean[]
  const todo = selectUnclaimed(manifest, claimed)
  console.log(
    `${manifest.length} holders · ${manifest.length - todo.length} already claimed · ${todo.length} to claim${dryRun ? ' (dry-run)' : ''}`,
  )

  let ok = 0
  let failed = 0
  for (const entry of todo) {
    const holder = getAddress(entry.holder)
    const claimArgs = [holder, entry.amounts.map(BigInt), entry.proof as `0x${string}`[]] as const
    try {
      await pub.simulateContract({ account, address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'claim', args: claimArgs })
    } catch (err) {
      failed++
      console.error(`  SKIP ${holder} — simulation reverted: ${(err as Error).message.split('\n')[0]}`)
      continue
    }
    if (dryRun) {
      ok++
      console.log(`  OK(sim) ${holder}`)
      continue
    }
    const hash = await wallet.writeContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'claim', args: claimArgs })
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status === 'success') {
      ok++
      console.log(`  OK ${holder} — ${hash}`)
    } else {
      failed++
      console.error(`  FAIL ${holder} — reverted ${hash}`)
    }
  }
  console.log(`done: ${ok} ${dryRun ? 'simulated' : 'claimed'}, ${failed} failed/skipped`)
  if (failed > 0) process.exitCode = 1
}

if (import.meta.main) await main()
