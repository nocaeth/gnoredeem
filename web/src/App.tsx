import { useEffect, useMemo, useState } from 'react'
import {
  useAccount,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { formatUnits, parseUnits } from 'viem'
import type { Address } from 'viem'
import { toast } from 'sonner'
import { erc20Abi, rateProviderAbi, redemptionDepositAbi } from './abis'
import {
  GNOSIS_CHAIN_ID,
  REDEMPTION_DEPOSIT_ADDRESS,
  REDEMPTION_SAFE_ADDRESS,
  STAKEWISE_RATE_PROVIDER,
  TOKENS,
  REDEMPTION_CLAIM_DATE,
  isDepositContractSet,
  isAddressSet,
  gnosisscanAddress,
} from './config'
import {
  formatTokenAmount,
  formatRate,
  formatAddress,
  formatCountdown,
  formatDateUtc,
} from './lib/format'
import { useBatchedDeposit } from './lib/batchedDeposit'
import { useClaim } from './lib/claim'

type Token = (typeof TOKENS)[number]

const contractLive = isDepositContractSet()

// ── Small presentational helpers ─────────────────────────────────────────────

// Flat section — the gno.now dashboard's ReportSection: a 14px tracked label and a
// 2px foreground rule, then content directly on the background. No box; boxes are
// reserved for the interactive deposit inputs below.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="pb-2 text-sm font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h2>
      <hr className="mb-6 border-t-2 border-foreground" />
      {children}
    </section>
  )
}

// Metric — the dashboard's MetricCard: 11px label + a display-scale mono numeral.
function Metric({
  label,
  value,
  unit,
  accent,
}: {
  label: string
  value: string
  unit?: string
  accent?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="section-label">{label}</span>
      <div className="flex items-baseline gap-2">
        <span
          className={`font-mono text-[1.25rem] leading-none tabular-nums sm:text-[1.75rem] ${accent ? 'text-accent' : 'text-foreground'}`}
        >
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
    </div>
  )
}

function AddressLink({ address }: { address: Address }) {
  return (
    <a
      href={gnosisscanAddress(address)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
    >
      {formatAddress(address)}
    </a>
  )
}

// ── Deposit card (one per token) ──────────────────────────────────────────────

function DepositCard({
  token,
  account,
  disabled,
}: {
  token: Token
  account: Address | undefined
  disabled: boolean
}) {
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState('')

  const { data: balance } = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account!],
    query: { enabled: !!account },
  })

  const { data: allowance } = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account!, REDEMPTION_DEPOSIT_ADDRESS],
    query: { enabled: !!account && contractLive },
  })

  const parsed = useMemo<bigint | null>(() => {
    if (!amount) return null
    try {
      return parseUnits(amount, token.decimals)
    } catch {
      return null
    }
  }, [amount, token.decimals])

  const overBalance = parsed !== null && balance !== undefined && parsed > balance
  const validAmount = parsed !== null && parsed > 0n && !overBalance
  const needsApproval = validAmount && (allowance === undefined || allowance < parsed!)

  const approve = useWriteContract()
  const deposit = useWriteContract()
  const approveRcpt = useWaitForTransactionReceipt({ hash: approve.data })
  const depositRcpt = useWaitForTransactionReceipt({ hash: deposit.data })
  const batch = useBatchedDeposit()

  useEffect(() => {
    if (approveRcpt.isSuccess) {
      void queryClient.invalidateQueries()
      toast.success(`${token.symbol} approved`)
      approve.reset()
    }
  }, [approveRcpt.isSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (depositRcpt.isSuccess) {
      void queryClient.invalidateQueries()
      toast.success(`Deposited ${amount} ${token.symbol}`)
      setAmount('')
      deposit.reset()
    }
  }, [depositRcpt.isSuccess]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (approve.error) toast.error(`Approve failed: ${approve.error.message.split('\n')[0]}`)
  }, [approve.error])
  useEffect(() => {
    if (deposit.error) toast.error(`Deposit failed: ${deposit.error.message.split('\n')[0]}`)
  }, [deposit.error])

  // EIP-5792 batched approve+deposit outcome (Safe / 5792-capable wallets).
  useEffect(() => {
    if (batch.status === 'success') {
      void queryClient.invalidateQueries()
      toast.success(`Deposited ${amount} ${token.symbol}`)
      setAmount('')
      batch.reset()
    } else if (batch.status === 'failure' && batch.error) {
      toast.error(`Deposit failed: ${batch.error.message.split('\n')[0]}`)
      batch.reset()
    }
  }, [batch.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const pending =
    approve.isPending ||
    approveRcpt.isLoading ||
    deposit.isPending ||
    depositRcpt.isLoading ||
    batch.status === 'pending' ||
    batch.status === 'queued'

  function onApprove() {
    if (!parsed) return
    approve.writeContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [REDEMPTION_DEPOSIT_ADDRESS, parsed],
    })
  }

  function onDeposit() {
    if (!parsed) return
    deposit.writeContract({
      address: REDEMPTION_DEPOSIT_ADDRESS,
      abi: redemptionDepositAbi,
      functionName: 'deposit',
      args: [token.address, parsed],
    })
  }

  function onAction() {
    if (!parsed) return
    // One atomic approve+deposit if the wallet supports it; else the two-step flow.
    if (needsApproval && batch.isBatchSupported) batch.sendDepositBatch(token.address, parsed)
    else if (needsApproval) onApprove()
    else onDeposit()
  }

  const buttonLabel = () => {
    if (batch.status === 'queued') return 'Awaiting Safe signatures…'
    if (approve.isPending || approveRcpt.isLoading) return 'Approving…'
    if (deposit.isPending || depositRcpt.isLoading || batch.status === 'pending') return 'Depositing…'
    if (needsApproval) return batch.isBatchSupported ? `Approve & Deposit ${token.symbol}` : `Approve ${token.symbol}`
    return `Deposit ${token.symbol}`
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-lg">{token.symbol}</span>
        <span className="flex items-baseline gap-1.5">
          <span className="section-label">Balance</span>
          <span className="font-mono tabular-nums text-foreground">
            {account ? formatTokenAmount(balance, token.decimals) : '—'}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-background px-3 py-2">
        <input
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          disabled={disabled || pending}
          onChange={(e) => {
            // Accept or reject the keystroke; never silently rewrite (e.g. "1e3"→"13") an irreversible deposit.
            const v = e.target.value
            if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v)
          }}
          className="w-full bg-transparent font-mono tabular-nums text-lg outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        <button
          type="button"
          disabled={disabled || pending || balance === undefined}
          onClick={() => balance !== undefined && setAmount(formatUnits(balance, token.decimals))}
          className="section-label shrink-0 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          Max
        </button>
      </div>

      {overBalance && <span className="text-xs text-negative">Exceeds your balance.</span>}

      <button
        type="button"
        disabled={disabled || pending || !validAmount}
        onClick={onAction}
        className="mt-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-foreground transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      >
        {buttonLabel()}
      </button>
    </div>
  )
}

// ── Claim section ───────────────────────────────────────────────────────────

// Phase 2. Always rendered so the claim path is discoverable; degrades to
// "not open yet" until the distributor + manifest are live, mirroring the deposit side.
function ClaimSection({ isConnected, wrongChain }: { isConnected: boolean; wrongChain: boolean }) {
  const { live, hasManifest, manifestLoading, manifestError, entry, basket, activated, claimed, claim, pending } =
    useClaim()

  return (
    <Section title="Claim your redemption">
      {!live ? (
        <p className="text-muted-foreground">
          Claiming is not open yet — it opens once the deposit window closes and the redemption
          basket is funded.
        </p>
      ) : !isConnected ? (
        <p className="text-muted-foreground">Connect your wallet to check your redemption.</p>
      ) : !hasManifest || manifestLoading ? (
        <p className="text-muted-foreground">Loading your redemption…</p>
      ) : manifestError ? (
        <p className="text-negative">Couldn’t load the redemption manifest — try again shortly.</p>
      ) : !entry ? (
        <p className="text-muted-foreground">
          No redemption found for this address. Only addresses that deposited during the window are
          eligible.
        </p>
      ) : (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
          <div className="grid grid-cols-2 gap-5">
            {basket?.map((leg) => (
              <Metric
                key={leg.token}
                label={leg.symbol}
                value={leg.decimals === undefined ? '—' : formatTokenAmount(leg.amount, leg.decimals)}
              />
            ))}
          </div>
          {claimed ? (
            <p className="text-sm text-foreground">
              Claimed ✓ — your redemption basket has been sent to this address.
            </p>
          ) : (
            <>
              <button
                type="button"
                disabled={pending || !activated || wrongChain}
                onClick={claim}
                className="rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-foreground transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              >
                {pending
                  ? 'Claiming…'
                  : wrongChain
                    ? 'Switch to Gnosis Chain'
                    : activated
                      ? 'Claim redemption'
                      : 'Claiming opens once funded'}
              </button>
              {!activated && (
                <p className="text-xs text-muted-foreground">
                  Your basket is finalized — the button activates once the distributor is funded with
                  the full redemption. Anyone may submit the claim; the basket always goes to your
                  address.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Section>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function App() {
  const { address: account, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const wrongChain = isConnected && chainId !== GNOSIS_CHAIN_ID

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  // ── Reads ──
  const { data: rate } = useReadContract({
    address: STAKEWISE_RATE_PROVIDER,
    abi: rateProviderAbi,
    functionName: 'getRate',
  })

  const { data: deadline } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'deadline',
    query: { enabled: contractLive },
  })

  // The contract is only deployed once GIP-151 has passed and the snapshot rate is
  // fixed, so once live this frozen rate — not the drifting oracle — is authoritative.
  const { data: frozenRate } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'osgnoRate',
    query: { enabled: contractLive },
  })

  const { data: gnoDeposited } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'deposited',
    args: [account!, TOKENS[0].address],
    query: { enabled: !!account && contractLive },
  })
  const { data: osgnoDeposited } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'deposited',
    args: [account!, TOKENS[1].address],
    query: { enabled: !!account && contractLive },
  })

  const { data: gnoTotal } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'totalDeposited',
    args: [TOKENS[0].address],
    query: { enabled: contractLive },
  })
  const { data: osgnoTotal } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'totalDeposited',
    args: [TOKENS[1].address],
    query: { enabled: contractLive },
  })

  // Immutables of the configured deposit contract — verified against config before allowing deposits.
  const { data: onchainGno } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'gno',
    query: { enabled: contractLive },
  })
  const { data: onchainOsgno } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'osgno',
    query: { enabled: contractLive },
  })
  const { data: onchainSafe } = useReadContract({
    address: REDEMPTION_DEPOSIT_ADDRESS,
    abi: redemptionDepositAbi,
    functionName: 'safe',
    query: { enabled: contractLive },
  })

  // ── Derived ──
  const windowClosed = deadline !== undefined && nowSec > Number(deadline)
  const secondsLeft = deadline !== undefined ? Number(deadline) - nowSec : NaN

  // Prefer the contract's fixed snapshot rate; fall back to the live oracle before deploy.
  const effectiveRate = frozenRate ?? rate
  const rateIsFrozen = frozenRate !== undefined

  // Hard safety gate: deposits are irreversible and forwarded straight to safe(), so the deployed
  // contract's token + Safe immutables MUST match the expected GIP-151 config. A mismatch (wrong
  // configured address / wrong Safe) disables deposits entirely — warning-only is too weak here.
  const immutablesLoaded =
    onchainGno !== undefined && onchainOsgno !== undefined && onchainSafe !== undefined
  const immutablesMismatch =
    immutablesLoaded &&
    (onchainGno.toLowerCase() !== TOKENS[0].address.toLowerCase() ||
      onchainOsgno.toLowerCase() !== TOKENS[1].address.toLowerCase() ||
      !isAddressSet(REDEMPTION_SAFE_ADDRESS) ||
      onchainSafe.toLowerCase() !== REDEMPTION_SAFE_ADDRESS.toLowerCase())

  let depositDisabled = false
  let disabledReason: string | null = null
  if (!contractLive) {
    depositDisabled = true
    disabledReason = 'Deposits are not open yet.'
  } else if (!immutablesLoaded) {
    depositDisabled = true
    disabledReason = 'Verifying the deposit contract…'
  } else if (immutablesMismatch) {
    depositDisabled = true
    disabledReason = null // surfaced by the prominent banner below
  } else if (!isConnected) {
    depositDisabled = true
    disabledReason = 'Connect your wallet to deposit.'
  } else if (wrongChain) {
    depositDisabled = true
    disabledReason = 'Switch to Gnosis Chain to deposit.'
  } else if (windowClosed) {
    depositDisabled = true
    disabledReason = 'The deposit window has closed.'
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:py-16">
      {/* Header — NOCA wordmark links home to the gno.now dashboard */}
      <header className="mb-12">
        <div className="mb-8 flex items-center justify-between gap-4">
          <a href="https://gno.now" aria-label="NOCA — gno.now treasury dashboard">
            <img src="/logos/noca-wordmark-white.svg" alt="NOCA" className="h-5 w-auto" />
          </a>
          <div className="shrink-0">
            <ConnectButton accountStatus="avatar" chainStatus="icon" showBalance={false} />
          </div>
        </div>
        <h1 className="text-[clamp(2.25rem,1rem+3vw,3.5rem)] font-bold leading-none tracking-tight">
          GnosisDAO Treasury Redemption
        </h1>
        <p className="mt-4 text-muted-foreground">
          Deposit GNO or osGNO to opt in to the GIP-151 redemption — a one-time pro-rata
          (proportional to your share) buyback by the GnosisDAO treasury.
        </p>
        {contractLive && deadline !== undefined && !windowClosed && (
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Deposit window closes in {formatCountdown(secondsLeft)}
          </p>
        )}
      </header>

      {wrongChain && (
        <button
          type="button"
          onClick={() => switchChain({ chainId: GNOSIS_CHAIN_ID })}
          className="mb-8 w-full rounded-lg border border-border bg-card px-4 py-2.5 font-medium text-foreground transition-colors hover:border-foreground"
        >
          Wrong network — switch to Gnosis Chain
        </button>
      )}

      {contractLive && immutablesMismatch && (
        <div className="mb-8 w-full rounded-lg border border-negative bg-card px-4 py-3 text-sm text-negative">
          <span className="font-semibold">Deposit contract failed verification.</span> Its GNO, osGNO,
          or Safe address doesn’t match the expected GIP-151 configuration. Deposits are disabled — do
          not proceed, and confirm you’re on the official site.
        </div>
      )}

      <div className="flex flex-col gap-10">
        {/* Deposit — the only boxed surface; it's an input, not a readout */}
        <div className="flex flex-col gap-3">
          <div className="grid gap-5 sm:grid-cols-2">
            {TOKENS.map((token) => (
              <DepositCard
                key={token.key}
                token={token}
                account={account}
                disabled={depositDisabled}
              />
            ))}
          </div>
          {depositDisabled && disabledReason && (
            <p className="text-center text-xs text-muted-foreground">{disabledReason}</p>
          )}
          <p className="text-center text-sm text-foreground">
            Deposits are final — they’re forwarded to the redemption Safe and cannot be withdrawn.
          </p>
        </div>

        {/* Claim — phase 2; always present, degrades to "not open yet" until the distributor is live */}
        <ClaimSection isConnected={isConnected} wrongChain={wrongChain} />

        {/* Your deposit so far */}
        <Section title="Your deposit so far">
          {!isConnected ? (
            <p className="text-muted-foreground">Connect your wallet to see your deposits.</p>
          ) : (
            <div className="grid grid-cols-2 gap-5">
              <Metric label="GNO deposited" value={formatTokenAmount(gnoDeposited, 18)} />
              <Metric label="osGNO deposited" value={formatTokenAmount(osgnoDeposited, 18)} />
            </div>
          )}
        </Section>

        {/* osGNO rate */}
        <Section title="osGNO rate">
          <Metric
            label={rateIsFrozen ? 'Fixed snapshot rate' : 'Current StakeWise rate'}
            value={effectiveRate !== undefined ? `1 osGNO ≈ ${formatRate(effectiveRate)} GNO` : '—'}
            accent={rateIsFrozen}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            {rateIsFrozen
              ? 'The osGNO→GNO rate fixed at the GIP-151 snapshot, used for every osGNO deposit.'
              : 'Live osGNO→GNO rate from StakeWise (osGNO is staked GNO).'}{' '}
            Source: <AddressLink address={STAKEWISE_RATE_PROVIDER} />
          </p>
        </Section>

        {/* Timeline — only once the contract is live and real dates exist */}
        {contractLive && (
          <Section title="Timeline">
            <div className="grid grid-cols-2 gap-5">
              <Metric
                label="Deposit window closes"
                value={
                  deadline !== undefined
                    ? windowClosed
                      ? 'Closed'
                      : formatCountdown(secondsLeft)
                    : 'TBD'
                }
              />
              <Metric
                label="Claiming opens"
                value={
                  REDEMPTION_CLAIM_DATE
                    ? formatDateUtc(Math.floor(new Date(REDEMPTION_CLAIM_DATE).getTime() / 1000))
                    : 'TBD'
                }
              />
            </div>
            {deadline !== undefined && !windowClosed && (
              <p className="mt-3 text-xs text-muted-foreground">
                Closes {formatDateUtc(Number(deadline))}.
              </p>
            )}
          </Section>
        )}

        {/* Transparency — only once the contract is live and there's data to show */}
        {contractLive && (
          <Section title="Transparency">
            <div className="grid grid-cols-2 gap-5">
              <Metric label="Total GNO deposited" value={formatTokenAmount(gnoTotal, 18)} />
              <Metric label="Total osGNO deposited" value={formatTokenAmount(osgnoTotal, 18)} />
            </div>
            <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Deposit contract</span>
                <AddressLink address={REDEMPTION_DEPOSIT_ADDRESS} />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Redemption Safe</span>
                {isAddressSet(REDEMPTION_SAFE_ADDRESS) ? (
                  <AddressLink address={REDEMPTION_SAFE_ADDRESS} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </div>
          </Section>
        )}
      </div>

      <footer className="mt-12 flex flex-col gap-1 border-t border-border pt-6 text-xs text-muted-foreground">
        <span>The official GIP-151 redemption for the GnosisDAO treasury, operated by NOCA.</span>
        <a
          href="https://gno.now"
          className="w-fit underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          gno.now — Treasury dashboard
        </a>
      </footer>
    </div>
  )
}
