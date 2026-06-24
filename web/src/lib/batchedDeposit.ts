/**
 * EIP-5792 one-click approve+deposit, for wallets that support atomic batching
 * (notably Safe{Wallet} and 5792-capable injected wallets). Falls back silently —
 * `isBatchSupported` is false when the wallet can't batch, and the caller then uses
 * the normal two-step approve → deposit flow.
 *
 * Capability parsing tolerates the several shapes wallets report (`atomic` vs
 * `atomicBatch`, numeric vs string chainId keys, `status:"supported"` vs
 * `supported:true`) — the lesson from the sDAI frontend's Safe batch work.
 */
import { useCallback, useMemo } from 'react'
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import { useAccount, useCallsStatus, useCapabilities, useSendCalls } from 'wagmi'
import { redemptionDepositAbi } from '../abis'
import { REDEMPTION_DEPOSIT_ADDRESS } from '../config'

type UnknownRecord = Record<string, unknown>
const isRecord = (v: unknown): v is UnknownRecord => typeof v === 'object' && v !== null

const isAtomicStatus = (s: unknown): boolean =>
  typeof s === 'string' && (s.toLowerCase() === 'supported' || s.toLowerCase() === 'ready')

const isSupportedAtomic = (v: unknown): boolean =>
  isRecord(v) && (isAtomicStatus(v.status) || v.supported === true)

const resolveEntry = (caps: unknown, chainId: number): unknown => {
  if (!isRecord(caps)) return undefined
  if (caps.atomic || caps.atomicBatch) return caps
  return caps[chainId] ?? caps[String(chainId)]
}

/** True when the connected wallet advertises EIP-5792 atomic batching on `chainId`. */
export function isAtomicBatchSupported(capabilities: unknown, chainId?: number): boolean {
  if (!chainId) return false
  const entry = resolveEntry(capabilities, chainId)
  if (!isRecord(entry)) return false
  return isSupportedAtomic(entry.atomic) || isSupportedAtomic(entry.atomicBatch)
}

export type BatchStatus = 'idle' | 'pending' | 'queued' | 'success' | 'failure'

export function useBatchedDeposit() {
  const { chainId } = useAccount()

  // Current chain only — and never retry, so a wallet without wallet_getCapabilities
  // resolves quickly to "unsupported" instead of hanging.
  const { data: capabilities } = useCapabilities({ query: { enabled: !!chainId, retry: false } })
  const isBatchSupported = useMemo(
    () => isAtomicBatchSupported(capabilities, chainId),
    [capabilities, chainId],
  )

  const { sendCalls, data, error: sendError, reset, isPending } = useSendCalls()
  const batchId = data?.id ?? null

  const { data: callsStatus, error: statusError } = useCallsStatus({
    id: batchId ?? '',
    query: {
      enabled: !!batchId,
      refetchInterval: (q) => {
        const s = q.state.data?.status
        return s === 'success' || s === 'failure' ? false : 2000
      },
    },
  })

  const txHash = callsStatus?.receipts?.[0]?.transactionHash ?? null

  const status: BatchStatus =
    sendError || statusError
      ? 'failure'
      : isPending || (batchId && !callsStatus)
        ? 'pending'
        : callsStatus?.status === 'success'
          ? 'success'
          : callsStatus?.status === 'failure'
            ? 'failure'
            : batchId
              ? 'queued'
              : 'idle'

  const error = (sendError ?? statusError) as Error | null

  const sendDepositBatch = useCallback(
    (token: Address, amount: bigint) => {
      reset()
      sendCalls({
        forceAtomic: true,
        calls: [
          {
            to: token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [REDEMPTION_DEPOSIT_ADDRESS, amount],
            }),
          },
          {
            to: REDEMPTION_DEPOSIT_ADDRESS,
            data: encodeFunctionData({
              abi: redemptionDepositAbi,
              functionName: 'deposit',
              args: [token, amount],
            }),
          },
        ],
      })
    },
    [reset, sendCalls],
  )

  return { isBatchSupported, status, txHash, error, sendDepositBatch, reset }
}
