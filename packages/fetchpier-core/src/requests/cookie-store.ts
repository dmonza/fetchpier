import { randomUUID } from 'crypto'
import {
  Cookie as LibCookie,
  CookieJar as LibJar,
  MemoryCookieStore,
  canonicalDomain,
  defaultPath
} from 'tough-cookie'
import type { Cookie, CookieRejectionReason, CookieSameSite, CookieSnapshot } from '@shared/types'

/**
 * REQ-0115 — translation between the workspace's cookie record and the RFC 6265
 * reference implementation's cookie object.
 *
 * The library owns the *decisions* (which cookies may be stored, which match a
 * URL, when they expire); this module owns the *shape*, so `cookies.json`, the
 * record type that crosses the IPC boundary and the Cookies panel are unchanged.
 *
 * Two fields have no counterpart in the library and are carried across by the
 * identity map rather than stuffed into the library's object: our `id` (the
 * panel edits and deletes by it) and `source` (response vs. hand-authored).
 */

/** Fields of a record that survive a re-capture and cannot be derived from the library. */
export interface PreviousIdentity {
  id: string
  createdAt: string
  source: Cookie['source']
}

/**
 * The (domain, path, name) triple — the library's own storage identity and the
 * jar's historical `sameTuple`. `\u0000` separates because it cannot occur in any
 * of the three, so no component can forge a boundary.
 */
export function identityKey(domain: string, path: string, name: string): string {
  return `${domain.toLowerCase()}\u0000${path}\u0000${name}`
}

function sameSiteToLib(v: CookieSameSite | null): string | undefined {
  return v ? v.toLowerCase() : undefined
}

function sameSiteFromLib(v: string | undefined): CookieSameSite | null {
  switch ((v ?? '').toLowerCase()) {
    case 'strict':
      return 'Strict'
    case 'lax':
      return 'Lax'
    case 'none':
      return 'None'
    default:
      return null
  }
}

function toDate(iso: string): Date | undefined {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms) : undefined
}

function fromDate(d: Date | 'Infinity' | null | undefined): string | null {
  if (!d || d === 'Infinity') return null
  return d.toISOString()
}

/** Our record → the library's cookie object. */
export function toLibCookie(c: Cookie): LibCookie {
  return new LibCookie({
    key: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    // The library spells "session cookie" as `expires: 'Infinity'`; we spell it `null`.
    expires: c.expires ? (toDate(c.expires) ?? 'Infinity') : 'Infinity',
    maxAge: c.maxAge ?? undefined,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: sameSiteToLib(c.sameSite),
    hostOnly: c.hostOnly,
    creation: toDate(c.createdAt) ?? null,
    // Deliberate: a relative lifetime is measured from `lastAccessed`, so this is
    // what makes a refreshed cookie expire from its LAST capture (REQ-0115 §6.3).
    lastAccessed: toDate(c.updatedAt) ?? null
  })
}

/**
 * The library's cookie object → our record. `previous` supplies the fields the
 * library does not model; without it a fresh identity is minted.
 */
export function fromLibCookie(lc: LibCookie, previous: PreviousIdentity | undefined): Cookie {
  // The library guarantees a creation date — its constructor substitutes `now`
  // for a missing or unparseable one — and preserves it across a re-capture, so
  // it is authoritative and needs no fallback of ours. The one visible effect is
  // that a hand-edited `cookies.json` with a broken timestamp reads as "created
  // now" rather than failing; the field is display-only, so that is acceptable.
  const createdAt = fromDate(lc.creation) ?? new Date().toISOString()
  const updatedAt = fromDate(lc.lastAccessed) ?? createdAt
  return {
    id: previous?.id ?? randomUUID(),
    name: lc.key,
    value: lc.value,
    domain: (lc.domain ?? '').toLowerCase(),
    path: lc.path ?? '/',
    expires: fromDate(lc.expires),
    maxAge: typeof lc.maxAge === 'number' ? lc.maxAge : null,
    secure: lc.secure,
    httpOnly: lc.httpOnly,
    sameSite: sameSiteFromLib(lc.sameSite),
    // `hostOnly` is null on a cookie the library has not stored yet; the
    // restrictive reading is the default everywhere in this change.
    hostOnly: lc.hostOnly ?? true,
    createdAt,
    updatedAt,
    source: previous?.source ?? 'response'
  }
}

/**
 * Build a library jar seeded with the records read from disk, plus the identity
 * map needed to put the ids back afterwards.
 *
 * Jar configuration, and why each setting is not the default:
 * - `rejectPublicSuffixes` — already the default; named here because it is one of
 *   the rules this change exists to gain, and a silent default flip would be a
 *   security regression.
 * - `prefixSecurity: 'strict'` — the default (`silent`) drops an offending cookie
 *   with no error, which is exactly the silent failure this change removes. Strict
 *   raises, and the raise becomes the user-visible warning.
 * - `allowSpecialUseDomain` — left at its default (`true`) so local targets work.
 */
export async function buildLibJar(
  records: Cookie[]
): Promise<{ jar: LibJar; previous: Map<string, PreviousIdentity> }> {
  const store = new MemoryCookieStore()
  const jar = new LibJar(store, {
    rejectPublicSuffixes: true,
    prefixSecurity: 'strict'
  })
  const previous = new Map<string, PreviousIdentity>()
  for (const rec of records) {
    previous.set(identityKey(rec.domain, rec.path, rec.name), {
      id: rec.id,
      createdAt: rec.createdAt,
      source: rec.source
    })
    // Seeded straight into the store: these cookies were already accepted when
    // they were captured, and re-validating them against a URL we no longer have
    // would drop legitimate state on every read.
    await store.putCookie(toLibCookie(rec))
  }
  return { jar, previous }
}

/** Every cookie currently in the jar, back in our record shape with ids restored. */
export async function drainLibJar(
  jar: LibJar,
  previous: Map<string, PreviousIdentity>
): Promise<Cookie[]> {
  const all = await jar.store.getAllCookies()
  return all.map((lc) =>
    fromLibCookie(lc, previous.get(identityKey(lc.domain ?? '', lc.path ?? '/', lc.key)))
  )
}

/** The ECMAScript Date range: ±8.64e15 ms around the epoch. */
const MAX_TIME_MS = 8.64e15

/**
 * The absolute expiry a relative `Max-Age` resolves to. A delta of zero or less
 * is already expired: it reports the base instant (the moment of receipt), a
 * date every surface can show — RFC 6265 §5.2.2's "earliest representable date"
 * would render as the year -271821 for the common logout cookie. An expiry past
 * the last representable date is replaced by that date (§5.2.2). The parser
 * accepts any integer, so without the clamp a spec-legal value makes
 * `toISOString` throw — and snapshots are formatted inside the transport's
 * cookie interceptor and execute's post-response block, where a throw fails the
 * whole send. `null` only when the base instant itself is unusable.
 */
function expiryFromMaxAge(baseMs: number, maxAge: number): string | null {
  if (!Number.isFinite(baseMs)) return null
  if (maxAge <= 0) return new Date(baseMs).toISOString()
  const ms = baseMs + maxAge * 1000
  return new Date(Number.isFinite(ms) && ms < MAX_TIME_MS ? ms : MAX_TIME_MS).toISOString()
}

/**
 * A cookie as one response offered it → the snapshot the adapters render.
 *
 * Deliberately independent of whether the jar went on to store it: the response
 * sent this, which is observable fact, and the user is entitled to see it even
 * when the jar refused it or was not running at all. `stored` is layered on by
 * the caller, which is the only party that knows the verdict.
 *
 * `receivedAt` resolves the effective expiry. A relative lifetime means nothing
 * without the moment of receipt, and resolving it here keeps every consumer from
 * re-deriving the specification's `Max-Age`-over-`Expires` precedence.
 */
export function snapshotFromSetCookie(
  header: string,
  requestUrl: string,
  receivedAt: Date = new Date()
): CookieSnapshot | null {
  const lc = LibCookie.parse(header)
  if (!lc) return null

  let host = ''
  let path = '/'
  try {
    const u = new URL(requestUrl)
    host = canonicalDomain(u.hostname) ?? u.hostname.toLowerCase()
    path = defaultPath(u.pathname || '/')
  } catch {
    // A URL we cannot parse still leaves the cookie's own attributes readable.
  }

  let expires: string | null = null
  if (typeof lc.maxAge === 'number') {
    expires = expiryFromMaxAge(receivedAt.getTime(), lc.maxAge)
  } else if (lc.expires && lc.expires !== 'Infinity') {
    expires = lc.expires.toISOString()
  }

  return {
    name: lc.key,
    value: lc.value,
    domain: lc.domain ? (canonicalDomain(lc.domain) ?? lc.domain.toLowerCase()) : host,
    path: lc.path ?? path,
    expires,
    secure: lc.secure,
    httpOnly: lc.httpOnly,
    sameSite: sameSiteFromLib(lc.sameSite),
    // No `Domain` attribute means the cookie is bound to the responding host.
    hostOnly: lc.domain == null,
    url: requestUrl
  }
}

/** A stored record → the same snapshot shape, for the attached direction. */
export function snapshotFromRecord(c: Cookie, hopUrl: string): CookieSnapshot {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires:
      c.maxAge !== null
        ? (expiryFromMaxAge(Date.parse(c.updatedAt), c.maxAge) ?? c.expires)
        : c.expires,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    hostOnly: c.hostOnly,
    url: hopUrl
  }
}

/**
 * Map a rejection from the library onto a stable reason the adapters can render.
 *
 * The library signals rejections as `Error` with distinguishable messages but no
 * codes, so this matches on wording. That is fragile by nature, which is why
 * `cookie-store.test.ts` pins one case per pattern against the installed version:
 * a reworded message fails the suite instead of silently collapsing every reason
 * into `REJECTED`.
 */
export function classifyRejection(err: unknown): CookieRejectionReason {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/public suffix/i.test(msg)) return 'PUBLIC_SUFFIX'
  if (/not in this host's domain/i.test(msg)) return 'DOMAIN_MISMATCH'
  if (/__(secure|host) prefix/i.test(msg)) return 'PREFIX_VIOLATION'
  return 'REJECTED'
}
