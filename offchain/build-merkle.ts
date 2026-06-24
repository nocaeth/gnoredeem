/**
 * GIP-151 redemption Merkle builder.
 *
 * Reads deposits (per holder: raw GNO + raw osGNO), applies the FIXED snapshot osGNO->GNO rate to
 * get each holder's GNO-equivalent weight, allocates each basket asset pro-rata by that weight, and
 * emits: the Merkle root, the committed per-token totals (for the RedemptionDistributor constructor),
 * and a claim manifest (per holder: amounts + proof).
 *
 * The leaf scheme matches RedemptionDistributor.claim EXACTLY: StandardMerkleTree with leaf encoding
 * ['address','uint256[]'] => keccak256(keccak256(abi.encode(account, amounts))), commutative pair
 * hashing — the same scheme OZ MerkleProof.verifyCalldata checks on-chain.
 *
 * Rounding discipline (matches the contract's gnoEquivalent and the expert-panel note):
 *   weight(holder)      = rawGNO + rawOsGNO * osgnoRate / 1e18      (floor, once per holder)
 *   alloc(holder,asset) = weight * assetTotal / totalWeight          (floor)
 *   committed(asset)    = sum of alloc over holders                  (<= assetTotal; flooring dust
 *                                                                      stays in the Safe, undistributed)
 * Fund the distributor with exactly `payoutTotals` and the solvency gate (activate()) will pass.
 *
 * deposits[] should be sourced from on-chain — the canonical record is the deposit contract's
 * `Deposited` events / `deposited(holder, token)` reads up to and including the deadline block.
 *
 * Usage:  bun build-merkle.ts <config.json> [out.json]
 */
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { readFileSync, writeFileSync } from 'node:fs'

const ONE = 10n ** 18n

type Hex = `0x${string}`
type Deposit = { holder: Hex; gno: string; osgno: string } // raw base units, as strings (bigint-safe)
type BasketAsset = { token: Hex; symbol: string; total: string } // gross amount earmarked for redeemers
type Config = { osgnoRate: string; deposits: Deposit[]; basket: BasketAsset[] }

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
function reqAddress(v: string, ctx: string): string {
  if (typeof v !== 'string' || !ADDRESS_RE.test(v)) throw new Error(`${ctx}: invalid address ${JSON.stringify(v)}`)
  return v.toLowerCase()
}
function reqUint(v: string, ctx: string): bigint {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) {
    throw new Error(`${ctx}: expected a non-negative integer string, got ${JSON.stringify(v)}`)
  }
  return BigInt(v)
}

export function build(cfg: Config) {
  const rate = BigInt(cfg.osgnoRate)
  if (rate <= 0n) throw new Error('osgnoRate must be > 0')
  if (!Array.isArray(cfg.basket) || cfg.basket.length === 0) throw new Error('empty basket')
  if (!Array.isArray(cfg.deposits) || cfg.deposits.length === 0) throw new Error('no deposits')

  // Validate the basket up front — fail loud, never emit a manifest that bricks the distributor.
  const seenToken = new Set<string>()
  for (const b of cfg.basket) {
    const t = reqAddress(b.token, `basket token "${b.symbol}"`)
    if (!b.symbol) throw new Error(`basket asset ${b.token} missing symbol`)
    if (reqUint(b.total, `basket "${b.symbol}" total`) === 0n) throw new Error(`basket "${b.symbol}" total must be > 0`)
    if (seenToken.has(t)) throw new Error(`duplicate basket token ${b.token}`)
    seenToken.add(t)
  }

  // 1. Per-holder GNO-equivalent weight (sum duplicate holder rows; e.g. GNO row + osGNO row).
  const weight = new Map<string, bigint>()
  for (const d of cfg.deposits) {
    const key = reqAddress(d.holder, 'deposit holder')
    const w = reqUint(d.gno, `${d.holder} gno`) + (reqUint(d.osgno, `${d.holder} osgno`) * rate) / ONE
    weight.set(key, (weight.get(key) ?? 0n) + w)
  }
  const holders = [...weight.entries()].filter(([, w]) => w > 0n).map(([h]) => h).sort()
  const totalWeight = holders.reduce((s, h) => s + weight.get(h)!, 0n)
  if (totalWeight === 0n) throw new Error('total GNO-equivalent is zero — no eligible deposits')

  // 2. Per-holder per-asset allocation (floor), and the committed total per asset.
  const committed = cfg.basket.map(() => 0n)
  const leaves: [string, string[]][] = holders.map((h) => {
    const w = weight.get(h)!
    const amounts = cfg.basket.map((b, i) => {
      const a = (w * BigInt(b.total)) / totalWeight
      committed[i] += a
      return a.toString()
    })
    return [h, amounts]
  })

  // Guard: every committed total must be > 0. The distributor constructor requires totals[i] > 0,
  // and a 0 means the asset is too small to allocate to anyone — drop it or increase the amount.
  cfg.basket.forEach((b, i) => {
    if (committed[i] === 0n) {
      throw new Error(
        `basket "${b.symbol}" allocates 0 after flooring (total ${b.total} too small for ${holders.length} holders) — remove it or increase the amount`,
      )
    }
  })

  // 3. Merkle tree — leaf encoding identical to the on-chain verifier.
  const tree = StandardMerkleTree.of(leaves, ['address', 'uint256[]'])

  return {
    root: tree.root,
    payoutTokens: cfg.basket.map((b) => b.token),
    payoutSymbols: cfg.basket.map((b) => b.symbol),
    payoutTotals: committed.map((c) => c.toString()),
    dust: cfg.basket.map((b, i) => (BigInt(b.total) - committed[i]).toString()),
    totalGnoEquivalent: totalWeight.toString(),
    holderCount: holders.length,
    manifest: leaves.map(([holder, amounts], i) => ({ holder, amounts, proof: tree.getProof(i) })),
  }
}

const [, , inPath, outPath = 'merkle-out.json'] = process.argv
if (!inPath) {
  console.error('usage: bun build-merkle.ts <config.json> [out.json]')
  process.exit(1)
}
const result = build(JSON.parse(readFileSync(inPath, 'utf8')) as Config)
writeFileSync(outPath, JSON.stringify(result, null, 2))
console.log(`root:    ${result.root}`)
console.log(`holders: ${result.holderCount}   totalGnoEquivalent: ${result.totalGnoEquivalent}`)
for (let i = 0; i < result.payoutTokens.length; i++) {
  console.log(`  ${result.payoutSymbols[i]}  total=${result.payoutTotals[i]}  dust=${result.dust[i]}`)
}
console.log(`wrote ${outPath}`)
