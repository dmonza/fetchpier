// Pure readers of the HTTP facts the findings rules look at. No I/O, never
// throws: an unreadable value reads as "absent".

import { isIP } from 'node:net'

/** A URL hostname without the brackets IPv6 literals carry. */
function bare(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Hosts the W3C Secure Contexts specification treats as potentially
 * trustworthy: `localhost`, names under `.localhost`, `127.0.0.0/8` and `::1`.
 * Traffic to them never leaves the machine. Private networks are not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const h = bare(host).toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (isIP(h) === 4) return h.split('.')[0] === '127'
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1'
  return false
}

/** Whether the host is an IPv4 or IPv6 address written literally. */
export function isIpLiteral(host: string): boolean {
  return isIP(bare(host)) !== 0
}

/**
 * The first `Strict-Transport-Security` header (several arrive joined by ", ";
 * a user agent processes only the first). `valid` is false without a numeric
 * `max-age`, which RFC 6797 requires — such a header is ignored by user agents.
 */
export function parseHsts(
  value: string | undefined
): { valid: boolean; maxAge?: number } | undefined {
  if (value === undefined) return undefined
  const first = value.split(',')[0]
  for (const part of first.split(';')) {
    const [rawName, ...rest] = part.split('=')
    if (rawName.trim().toLowerCase() !== 'max-age') continue
    const v = rest
      .join('=')
      .trim()
      .replace(/^"(.*)"$/, '$1')
    return /^\d+$/.test(v) ? { valid: true, maxAge: Number(v) } : { valid: false }
  }
  return { valid: false }
}

/** Whether a Content-Security-Policy declares a `frame-ancestors` directive. */
export function cspHasFrameAncestors(csp: string | undefined): boolean {
  if (!csp) return false
  return csp
    .split(/[;,]/)
    .some((d) => d.trim().split(/\s+/)[0]?.toLowerCase() === 'frame-ancestors')
}

/** `Cache-Control` directive names, lowercased (values ignored). */
export function cacheControlDirectives(value: string | undefined): Set<string> {
  const out = new Set<string>()
  if (!value) return out
  for (const part of value.split(',')) {
    const name = part.split('=')[0].trim().toLowerCase()
    if (name) out.add(name)
  }
  return out
}

/** `Cache-Control` directives with their values (unquoted), split respecting quoted field lists. */
function cacheControlEntries(value: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!value) return out
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    if (ch === ',' && !quoted) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  parts.push(current)
  for (const part of parts) {
    const i = part.indexOf('=')
    const name = (i === -1 ? part : part.slice(0, i)).trim().toLowerCase()
    if (!name || out.has(name)) continue
    out.set(
      name,
      i === -1
        ? ''
        : part
            .slice(i + 1)
            .trim()
            .replace(/^"(.*)"$/s, '$1')
    )
  }
  return out
}

const positiveSeconds = (v: string | undefined): boolean =>
  v !== undefined && /^\d+$/.test(v) && Number(v) > 0

/**
 * Whether a response is **explicitly** cacheable by a shared cache (RFC 9111):
 * `public`, a positive `s-maxage` or `max-age`, or — with neither freshness
 * directive present — an `Expires` in the future. Heuristic freshness does not
 * count. `private` (in any form), `no-store`, and `no-cache` bare or naming
 * `Set-Cookie` protect the response.
 */
export function isExplicitlyShareable(
  cacheControl: string | undefined,
  expires: string | undefined,
  now: Date
): boolean {
  const cc = cacheControlEntries(cacheControl)
  if (cc.has('private') || cc.has('no-store')) return false
  if (cc.has('no-cache')) {
    const fields = cc.get('no-cache') ?? ''
    if (!fields || fields.split(',').some((f) => f.trim().toLowerCase() === 'set-cookie')) {
      return false
    }
  }
  if (cc.has('public')) return true
  if (positiveSeconds(cc.get('s-maxage')) || positiveSeconds(cc.get('max-age'))) return true
  if (cc.has('max-age') || cc.has('s-maxage')) return false
  if (!expires) return false
  const at = new Date(expires)
  return !Number.isNaN(at.getTime()) && at.getTime() > now.getTime()
}

/**
 * Whether a negotiated cipher provides forward secrecy: always on TLS 1.3; on
 * older versions only with an ephemeral key exchange (`ECDHE`, `DHE`, `EDH`) —
 * the markers both the IANA and the runtime's naming carry.
 */
export function hasForwardSecrecy(protocol: string, cipher: string): boolean {
  if (protocol === 'TLSv1.3') return true
  return /ECDHE|DHE|EDH/i.test(cipher)
}

/** The media type of a `Content-Type`, lowercased, without parameters. */
export function mediaType(value: string | undefined): string {
  return (value ?? '').split(';')[0].trim().toLowerCase()
}

/**
 * Whether a `Server` / `X-Powered-By` value carries a version: a dotted numeric
 * sequence (`1.25`, `8.2.1`) or `/` followed by a digit (`nginx/1.25.3`, `PHP/8`).
 */
export function hasVersionToken(value: string): boolean {
  return /\d+\.\d+/.test(value) || /\/\d/.test(value)
}

export interface SetCookieAttributes {
  name: string
  secure: boolean
  httpOnly: boolean
  /** `Max-Age` ≤ 0, or (without `Max-Age`) an `Expires` in the past. */
  deletion: boolean
}

/** The attributes of one `Set-Cookie` value; `null` when it names no cookie. */
export function parseSetCookie(header: string, now: Date): SetCookieAttributes | null {
  const [pair, ...attrs] = header.split(';')
  const eq = pair.indexOf('=')
  const name = (eq === -1 ? '' : pair.slice(0, eq)).trim()
  if (!name) return null
  let secure = false
  let httpOnly = false
  let maxAge: number | undefined
  let expires: Date | undefined
  for (const attr of attrs) {
    const i = attr.indexOf('=')
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
    const value = i === -1 ? '' : attr.slice(i + 1).trim()
    if (key === 'secure') secure = true
    else if (key === 'httponly') httpOnly = true
    else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value)
    else if (key === 'expires') {
      const d = new Date(value)
      if (!Number.isNaN(d.getTime())) expires = d
    }
  }
  const deletion =
    maxAge !== undefined ? maxAge <= 0 : expires !== undefined && expires.getTime() < now.getTime()
  return { name, secure, httpOnly, deletion }
}

/** Decoded query-parameter names of a URL, in order (a name that cannot be decoded is kept raw). */
export function queryParameterNames(url: string): string[] {
  const q = url.indexOf('?')
  if (q === -1) return []
  const query = url.slice(q + 1).split('#')[0]
  if (!query) return []
  return query
    .split('&')
    .filter((s) => s.length > 0)
    .map((segment) => {
      const raw = segment.split('=')[0].replace(/\+/g, ' ')
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    })
    .filter((name) => name.length > 0)
}

/** Credential names, normalized (lowercase, without `-` and `_`). */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  'token',
  'accesstoken',
  'apikey',
  'key',
  'secret',
  'password',
  'pwd',
  'auth'
])

/** `name` lowercased without `-` and `_`. */
export function normalizeParameterName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '')
}

/** Whether a whole query-parameter name is a credential name (never a substring match). */
export function isCredentialParameterName(name: string): boolean {
  return CREDENTIAL_NAMES.has(normalizeParameterName(name))
}
