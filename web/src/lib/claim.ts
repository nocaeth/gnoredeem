/**
 * Claim phase — look up the connected account in the published GIP-151 redemption
 * manifest, read the distributor's live state, and submit claim().
 *
 * Degrades exactly like the deposit side: until REDEMPTION_DISTRIBUTOR_ADDRESS and a
 * manifest URL are set, `live` is false and the UI shows "not open yet".
 *
 * The manifest is the build-merkle output: per-holder { amounts, proof } aligned to
 * payoutTokens/payoutSymbols. We trust it ONLY for display + the proof bytes — the
 * proof is verified on-chain by claim() against the immutable root, so a wrong or
 * stale manifest can only revert (InvalidProof); it can never mis-pay.
 */
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { erc20Abi, redemptionDistributorAbi } from '../abis'
import {
  REDEMPTION_CLAIM_MANIFEST_URL,
  REDEMPTION_DISTRIBUTOR_ADDRESS,
  isClaimLive,
} from '../config'

export type ClaimEntry = { holder: string; amounts: string[]; proof: `0x${string}`[] }
export type ClaimManifest = {
  root: `0x${string}`
  payoutTokens: Address[]
  payoutSymbols: string[]
  payoutTotals: string[]
  manifest: ClaimEntry[]
}
export type BasketLeg = { token: Address; symbol: string; amount: bigint; decimals: number }

const live = isClaimLive()

function useManifest() {
  return useQuery<ClaimManifest>({
    queryKey: ['claim-manifest', REDEMPTION_CLAIM_MANIFEST_URL],
    enabled: live && !!REDEMPTION_CLAIM_MANIFEST_URL,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch(REDEMPTION_CLAIM_MANIFEST_URL as string)
      if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`)
      return (await res.json()) as ClaimManifest
    },
  })
}

export function useClaim() {
  const { address: account } = useAccount()
  const queryClient = useQueryClient()
  const manifest = useManifest()

  const entry: ClaimEntry | null =
    (account &&
      manifest.data?.manifest.find((m) => m.holder.toLowerCase() === account.toLowerCase())) ||
    null

  const { data: activated } = useReadContract({
    address: REDEMPTION_DISTRIBUTOR_ADDRESS,
    abi: redemptionDistributorAbi,
    functionName: 'activated',
    query: { enabled: live },
  })

  const { data: claimed } = useReadContract({
    address: REDEMPTION_DISTRIBUTOR_ADDRESS,
    abi: redemptionDistributorAbi,
    functionName: 'hasClaimed',
    args: [account as Address],
    query: { enabled: live && !!account },
  })

  // Per-token decimals so the basket renders honestly (it can mix 18-dec GNO-likes and 6-dec USDC).
  const tokens = manifest.data?.payoutTokens ?? []
  const { data: decimalsData } = useReadContracts({
    contracts: tokens.map((token) => ({
      address: token,
      abi: erc20Abi,
      functionName: 'decimals',
    })),
    query: { enabled: live && tokens.length > 0 },
  })

  const basket: BasketLeg[] | null =
    entry && manifest.data
      ? manifest.data.payoutTokens.map((token, i) => ({
          token,
          symbol: manifest.data!.payoutSymbols[i] ?? '?',
          amount: BigInt(entry.amounts[i] ?? '0'),
          decimals: Number(decimalsData?.[i]?.result ?? 18),
        }))
      : null

  const { writeContract, data: hash, error, isPending, reset } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash })

  useEffect(() => {
    if (receipt.isSuccess) {
      void queryClient.invalidateQueries()
      toast.success('Redemption claimed')
      reset()
    }
  }, [receipt.isSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (error) toast.error(`Claim failed: ${error.message.split('\n')[0]}`)
  }, [error])

  function claim() {
    if (!account || !entry) return
    writeContract({
      address: REDEMPTION_DISTRIBUTOR_ADDRESS,
      abi: redemptionDistributorAbi,
      functionName: 'claim',
      args: [account, entry.amounts.map((a) => BigInt(a)), entry.proof],
    })
  }

  return {
    live,
    hasManifest: !!REDEMPTION_CLAIM_MANIFEST_URL,
    manifestLoading: manifest.isLoading,
    manifestError: manifest.isError,
    entry,
    basket,
    activated,
    claimed,
    claim,
    pending: isPending || receipt.isLoading,
  }
}
