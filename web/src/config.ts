/**
 * Single source of configuration for the GIP-151 redemption deposit app.
 *
 * Everything that depends on the real deployment / vote outcome lives here as a
 * clearly-marked TODO. The UI degrades gracefully when these are unset.
 */

import type { Address } from 'viem'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

// ── Chain ──────────────────────────────────────────────────────────────────
export const GNOSIS_CHAIN_ID = 100 as const

/** Read RPC for Gnosis Chain. Override with VITE_GNOSIS_RPC. */
export const GNOSIS_RPC: string =
  import.meta.env.VITE_GNOSIS_RPC ?? 'https://rpc.gnosischain.com'

/** WalletConnect Cloud project id. Injected wallets work without it. */
export const WALLETCONNECT_PROJECT_ID: string =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? 'YOUR_WALLETCONNECT_PROJECT_ID'

// ── Token addresses (verified on Gnosis Chain, chainId 100) ──────────────────
export const GNO_ADDRESS: Address = '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb'
export const OSGNO_ADDRESS: Address = '0xF490c80aAE5f2616d3e3BDa2483E30C4CB21d1A0'

/** Stakewise rate provider — getRate() returns the osGNO→GNO rate scaled 1e18. */
export const STAKEWISE_RATE_PROVIDER: Address =
  '0x9B1b13afA6a57e54C03AD0428a4766C39707D272'

// ── Deployment-dependent — set these once the contract is live ───────────────

/**
 * TODO: deploy RedemptionDeposit, then paste its Gnosis Chain address here.
 * While this is the zero address the deposit UI shows "Deposits not open yet".
 */
export const REDEMPTION_DEPOSIT_ADDRESS: Address = ZERO_ADDRESS

/**
 * TODO: set the Redemption Safe address (the Safe that receives deposits / pays out).
 * Used only for the transparency link.
 */
export const REDEMPTION_SAFE_ADDRESS: Address = ZERO_ADDRESS

/**
 * TODO: redemption (claim) date — when claiming will be possible. This depends on
 * when the GIP-151 vote passes, so it is a placeholder. Set to a real ISO datetime
 * (UTC) once known, or leave null to show "TBD".
 */
export const REDEMPTION_CLAIM_DATE: string | null = null // e.g. '2026-08-15T00:00:00Z'

/**
 * TODO: deploy RedemptionDistributor (the claim-phase contract), then paste its
 * Gnosis Chain address here. While this is the zero address the claim UI shows
 * "Claiming is not open yet".
 */
export const REDEMPTION_DISTRIBUTOR_ADDRESS: Address = ZERO_ADDRESS

/**
 * TODO: published claim manifest — the build-merkle output (per-holder { amounts,
 * proof } plus payoutTokens/payoutSymbols). Host it statically (or pin on IPFS) and
 * put the URL here. The proof is verified on-chain by claim(), so a wrong/stale
 * manifest can only revert — it can never mis-pay. Leave null until the root is live.
 */
export const REDEMPTION_CLAIM_MANIFEST_URL: string | null = null // e.g. '/claim-manifest.json'

// ── Derived helpers ──────────────────────────────────────────────────────────
export const isAddressSet = (a: Address): boolean =>
  a.toLowerCase() !== ZERO_ADDRESS.toLowerCase()

export const isDepositContractSet = (): boolean =>
  isAddressSet(REDEMPTION_DEPOSIT_ADDRESS)

export const isClaimLive = (): boolean =>
  isAddressSet(REDEMPTION_DISTRIBUTOR_ADDRESS)

// ── Token metadata for the UI ────────────────────────────────────────────────
export const TOKENS = [
  { key: 'GNO', address: GNO_ADDRESS, symbol: 'GNO', decimals: 18 },
  { key: 'osGNO', address: OSGNO_ADDRESS, symbol: 'osGNO', decimals: 18 },
] as const

export const GNOSISSCAN = 'https://gnosisscan.io'
export const gnosisscanAddress = (a: Address): string => `${GNOSISSCAN}/address/${a}`
