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
const REDACTED = '[REDACTED]'

/**
 * The credential an API-key auth scheme materializes: its (resolved) parameter
 * or header name and where it lands. Recognized by the configured scheme, never
 * guessed from names — a heuristic would hide useful data and give false
 * confidence about what it caught.
 */
export interface ApiKeyCredential {
  location: 'header' | 'query'
  name: string
}

/** `name=value; name2=value2` → names kept, values redacted. */
function redactCookieHeader(value: string): string {
  return value
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=')
      return eq === -1 ? pair : `${pair.slice(0, eq + 1)}${REDACTED}`
    })
    .join(';')
}

/**
 * One or more `Set-Cookie` values joined with `, ` (how the response headers are
 * normalized). Only the leading `name=value` of each cookie is redacted; the
 * attributes stay. A cookie starts at the beginning or after a comma and its
 * name has no whitespace, which is what keeps the comma inside an `Expires` date
 * from being read as a boundary.
 */
function redactSetCookieHeader(value: string): string {
  return value.replace(/(^|,\s*)([^=;,\s]+)=([^;]*)/g, `$1$2=${REDACTED}`)
}

/**
 * Redact credentials and cookie values in headers unless `showSecrets` is set:
 * `Authorization` / `Proxy-Authorization` (scheme kept, credential masked),
 * `Cookie` and `Set-Cookie` (names and attributes kept, values masked), and the
 * header the request's API-key auth scheme materialized. Other headers pass
 * through unchanged.
 */
export function redactHeaders(
  headers: Record<string, string>,
  showSecrets = false,
  apiKey?: ApiKeyCredential
): Record<string, string> {
  if (showSecrets) return { ...headers }
  const apiKeyHeader = apiKey?.location === 'header' ? apiKey.name.trim().toLowerCase() : undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (SECRET_HEADER_RE.test(k)) {
      const space = v.indexOf(' ')
      out[k] = space > 0 ? `${v.slice(0, space)} ${REDACTED}` : REDACTED
    } else if (apiKeyHeader !== undefined && lower === apiKeyHeader) {
      out[k] = REDACTED
    } else if (lower === 'cookie') {
      out[k] = redactCookieHeader(v)
    } else if (lower === 'set-cookie') {
      out[k] = redactSetCookieHeader(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Redact the API-key auth scheme's query parameter value, keeping its name. */
export function redactUrl(url: string, apiKey?: ApiKeyCredential, showSecrets = false): string {
  if (showSecrets || apiKey?.location !== 'query' || !apiKey.name) return url
  const names = [...new Set([apiKey.name, encodeURIComponent(apiKey.name)])].map(escapeRegExp)
  const re = new RegExp(`([?&])(${names.join('|')})=([^&#]*)`, 'g')
  return url.replace(re, `$1$2=${REDACTED}`)
}

/** Body bytes shown at `-vvv` before cutting (the JSON report carries the full body). */
export const BODY_DISPLAY_LIMIT_BYTES = 64 * 1024

/** Cut a body for display, reporting whether it was cut and its full size. */
export function truncateBody(
  body: string,
  limitBytes = BODY_DISPLAY_LIMIT_BYTES
): { text: string; truncated: boolean; totalBytes: number } {
  const totalBytes = Buffer.byteLength(body, 'utf-8')
  if (totalBytes <= limitBytes) return { text: body, truncated: false, totalBytes }
  return {
    text: Buffer.from(body, 'utf-8').subarray(0, limitBytes).toString('utf-8'),
    truncated: true,
    totalBytes
  }
}

/** Byte length of a UTF-8 string (matches what the wire actually carried). */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8')
}
