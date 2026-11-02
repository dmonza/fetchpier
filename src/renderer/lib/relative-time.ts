/**
 * Localized relative time ("2 days ago", "hace 2 días") for keystore metadata
 * such as `lastUsedAt`. Uses the platform `Intl.RelativeTimeFormat`; falls back
 * to the raw ISO string if it cannot be parsed.
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

export function formatRelative(iso: string, locale: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso
  const diffMs = then - Date.now()
  const abs = Math.abs(diffMs)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (abs < MINUTE) return rtf.format(Math.round(diffMs / 1000), 'second')
  if (abs < HOUR) return rtf.format(Math.round(diffMs / MINUTE), 'minute')
  if (abs < DAY) return rtf.format(Math.round(diffMs / HOUR), 'hour')
  if (abs < MONTH) return rtf.format(Math.round(diffMs / DAY), 'day')
  if (abs < YEAR) return rtf.format(Math.round(diffMs / MONTH), 'month')
  return rtf.format(Math.round(diffMs / YEAR), 'year')
}
