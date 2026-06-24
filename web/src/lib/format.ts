/**
 * Tiny formatting layer — reused everywhere so token amounts and addresses
 * render consistently. Matches the gno.now conventions: thousands separators,
 * tabular numerals, addresses as `0x1234…abcd` (4+4, em-dash ellipsis).
 */

import { formatUnits } from 'viem'

/** Plain number with comma separators and a capped number of decimals. */
export function formatNumber(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value)
}

/**
 * Format a bigint token balance (raw on-chain units) into a human string with
 * thousands separators. Defaults to 4 decimals — enough for GNO-scale amounts.
 *
 * Honesty matters on a money screen: the on-chain value carries 18 decimals but
 * we only show a few, so we never round silently. A value rounded for display is
 * prefixed "≈"; a non-zero value too small to show at this precision renders as
 * "< 0.0001" rather than a misleading "0".
 */
export function formatTokenAmount(
  value: bigint | undefined,
  tokenDecimals = 18,
  displayDecimals = 4,
): string {
  if (value === undefined) return '—'
  const asNumber = Number(formatUnits(value, tokenDecimals))
  if (asNumber === 0) return '0'
  const shown = formatNumber(asNumber, displayDecimals)
  const shownNumber = Number(shown.replace(/,/g, ''))
  if (shownNumber === 0) {
    // Non-zero, but rounds to zero at this precision — don't claim it's nothing.
    return `< ${formatNumber(1 / 10 ** displayDecimals, displayDecimals)}`
  }
  return shownNumber === asNumber ? shown : `≈ ${shown}`
}

/** Format the 1e18-scaled Stakewise rate as a plain number (e.g. "1.15974"). */
export function formatRate(rate: bigint | undefined, displayDecimals = 5): string {
  if (rate === undefined) return '—'
  return formatNumber(Number(formatUnits(rate, 18)), displayDecimals)
}

/** Wallet/contract address for display: 0x1234…abcd (em-dash ellipsis). */
export function formatAddress(address: string | undefined): string {
  if (typeof address !== 'string' || address.length === 0) return '—'
  if (address.length <= 10) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * Compact countdown like "13d 04h 22m 10s" / "04h 22m 10s" / "closed".
 * `seconds` is the remaining whole seconds (clamped at 0).
 */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'closed'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`
  return `${pad(h)}h ${pad(m)}m ${pad(s)}s`
}

/** Format a unix-seconds timestamp as a UTC datetime string. */
export function formatDateUtc(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return 'TBD'
  return new Date(unixSeconds * 1000).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}
