// Pure formatting helpers — no I/O, no color. Kept separate so the reporter and
// the JSON/JUnit/HTML reporters can share identical number/size rendering and so
// they are trivially unit-testable.

/** Format a millisecond duration: `142ms`, `1.20s`, `2m 3s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(2)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

/** Format a byte count: `0B`, `387B`, `1.2KB`, `4.5MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${trim(kb)}KB`
  const mb = kb / 1024
  return `${trim(mb)}MB`
}

function trim(n: number): string {
  // One decimal, but drop a trailing `.0`.
  return n.toFixed(1).replace(/\.0$/, '')
}

const SECRET_HEADER_RE = /^(authorization|proxy-authorization)$/i

/**
 * Redact secret header values unless `showSecrets` is set. The scheme prefix
 * (e.g. `Bearer`) is kept; only the credential is masked. Non-secret headers
 * pass through unchanged.
 */
export function redactHeaders(
  headers: Record<string, string>,
  showSecrets = false
): Record<string, string> {
  if (showSecrets) return { ...headers }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (SECRET_HEADER_RE.test(k)) {
      const space = v.indexOf(' ')
      out[k] = space > 0 ? `${v.slice(0, space)} [REDACTED]` : '[REDACTED]'
    } else {
      out[k] = v
    }
  }
  return out
}

/** Byte length of a UTF-8 string (matches what the wire actually carried). */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8')
}
