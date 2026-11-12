import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  Cookie as LibCookie,
  canonicalDomain,
  defaultPath,
  domainMatch,
  getPublicSuffix,
  pathMatch
} from 'tough-cookie'
import type { Cookie, CookieJar, CookieRejectionReason, CookieSnapshot } from '@shared/types'
import { assertSafeIdentifier } from '../workspace/safe-path'
import { atomicWriteFile } from '../workspace/atomic-write'
import { envFolderPath, resolveEnvFolder } from '../workspace/environments'
import {
  buildLibJar,
  classifyRejection,
  drainLibJar,
  fromLibCookie,
  identityKey,
  snapshotFromRecord,
  snapshotFromSetCookie
} from './cookie-store'

const STATE_DIR = '.state'
const COOKIES_FILE = 'cookies.json'

/**
 * REQ-0115 — the jar delegates every RFC 6265 decision (which cookies may be
 * stored, which match a URL, when they expire) to the specification's reference
 * implementation, and keeps ownership of the workspace file format, the record
 * identity (`id`, `source`) and the one storage rule the library does not
 * implement: "leave secure cookies alone" (see `isSecureOverwrite`).
 *
 * The library jar is built **per operation**, never cached. That is deliberate:
 * every operation already reads and writes the file, which is what makes the
 * folder-rename detection below meaningful. A cached instance would break it.
 */

/** Why a cookie a response offered was not stored, and which hop offered it. */
export interface CookieRejection {
  name: string
  host: string
  reason: CookieRejectionReason
}

/** Outcome of capturing the `Set-Cookie` headers of one response. */
export interface CookieCaptureResult {
  /** Cookies stored, in their persisted shape. */
  accepted: Cookie[]
  /** Cookies refused, with the reason. Never throws — refusal is data. */
  rejected: CookieRejection[]
  /**
   * Cookies that **were** stored but carry `SameSite=None` without `Secure` — a
   * combination a browser refuses, reported so the divergence is visible.
   */
  crossSiteInsecure: { name: string; host: string }[]
}

// ── Path helpers ────────────────────────────────────────────────────────────

/**
 * The jar lives inside the environment's **folder**, which is resolved from the
 * opaque identifier every time (§6.10). Resolution happens once per read and once
 * per write rather than once per operation: that is deliberate, so a folder
 * renamed between an operation's read and its write is detected — the write fails
 * with `ENVIRONMENT_NOT_FOUND` instead of landing on a stale path or recreating
 * one, which would silently lose the captured cookies.
 *
 * The resolved folder is still passed through `assertSafeIdentifier` (path
 * separators, NUL bytes, pure-dot segments) before it reaches the filesystem.
 */
async function cookieFilePath(workspacePath: string, environmentId: string): Promise<string> {
  const folder = await resolveEnvFolder(workspacePath, environmentId)
  assertSafeIdentifier(folder, 'environment folder')
  return join(envFolderPath(workspacePath, folder), STATE_DIR, COOKIES_FILE)
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Normalize a record read from disk. Records written before REQ-0115 carry no
 * `hostOnly`, and it is read as `true` — the restrictive reading. The information
 * needed to be accurate was never stored; the cost of being wrong this way is one
 * re-login, against a leak that would otherwise persist for every cookie already
 * on disk (REQ-0115 §6.8).
 */
function normalizeRecord(raw: Cookie): Cookie {
  return {
    ...raw,
    domain: (raw.domain ?? '').toLowerCase(),
    path: raw.path || '/',
    hostOnly: typeof raw.hostOnly === 'boolean' ? raw.hostOnly : true
  }
}

async function readJar(workspacePath: string, environmentId: string): Promise<CookieJar> {
  const filePath = await cookieFilePath(workspacePath, environmentId)
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as CookieJar
    return {
      environmentId: parsed.environmentId ?? environmentId,
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies.map(normalizeRecord) : []
    }
  } catch {
    return { environmentId, cookies: [] }
  }
}

async function writeJar(workspacePath: string, jar: CookieJar): Promise<void> {
  const filePath = await cookieFilePath(workspacePath, jar.environmentId)
  if (jar.cookies.length === 0) {
    // Empty jar: never leave a stale file on disk. Mirrors the cleanup that
    // `remove()` performs when the last cookie is dropped.
    await fs.unlink(filePath).catch(() => undefined)
    return
  }
  await atomicWriteFile(filePath, JSON.stringify(jar, null, 2))
}

/**
 * Every read-modify-write of one jar file runs under this in-process lock, keyed
 * by (workspace, environment). A send and the Cookies panel share the file: two
 * unserialized writers each write back the state they read, and the later one
 * silently undoes the other — a captured session lost, a "Clear all" reverted.
 *
 * The lock is not reentrant: locked functions never call each other.
 */
const jarLocks = new Map<string, Promise<void>>()

async function withJarLock<T>(
  workspacePath: string,
  environmentId: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = `${workspacePath}\u0000${environmentId}`
  const run = (jarLocks.get(key) ?? Promise.resolve()).then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  jarLocks.set(key, tail)
  try {
    return await run
  } finally {
    if (jarLocks.get(key) === tail) jarLocks.delete(key)
  }
}

async function unlinkJar(workspacePath: string, environmentId: string): Promise<void> {
  const filePath = await cookieFilePath(workspacePath, environmentId)
  await fs.unlink(filePath).catch(() => undefined)
}

// ── Expiry ──────────────────────────────────────────────────────────────────

/**
 * A relative lifetime is measured from `updatedAt` — the last time the cookie was
 * received — not from `createdAt` (REQ-0115 §6.3). A server that refreshes a
 * sliding session keeps it alive; measuring from the first capture dropped it at
 * the original deadline while the server still considered it valid.
 */
function isExpired(cookie: Cookie, now = Date.now()): boolean {
  if (cookie.maxAge !== null) {
    const from = Date.parse(cookie.updatedAt)
    if (!Number.isFinite(from)) return false
    return from + cookie.maxAge * 1000 <= now
  }
  if (cookie.expires) {
    const expiry = Date.parse(cookie.expires)
    if (!Number.isFinite(expiry)) return false
    return expiry <= now
  }
  return false
}

function dropExpired(cookies: Cookie[]): Cookie[] {
  const now = Date.now()
  return cookies.filter((c) => !isExpired(c, now))
}

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Would this stored cookie be attached to a request for `requestUrl`?
 *
 * Kept as a pure predicate (the jar's own send path goes through the library),
 * because "would this be sent here" is a question worth being able to ask
 * directly — the panel, the benchmarks and the tests all do.
 */
export function matchesRequest(cookie: Cookie, requestUrl: string, now = Date.now()): boolean {
  if (isExpired(cookie, now)) return false
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return false
  }
  const host = canonicalDomain(url.hostname) ?? url.hostname.toLowerCase()
  // REQ-0115: a host-only cookie is bound to its exact host. A cookie captured
  // with no `Domain` attribute is host-only, which is the restrictive default
  // most session frameworks emit — matching it by suffix leaked credentials to
  // every subdomain.
  if (cookie.hostOnly) {
    if (cookie.domain !== host) return false
  } else if (!domainMatch(host, cookie.domain, true)) {
    return false
  }
  if (!pathMatch(url.pathname || '/', cookie.path)) return false
  if (cookie.secure && !isSecureContext(url)) return false
  return true
}

/**
 * Whether the connection counts as secure for cookie purposes. Mirrors the
 * library's `allowSecureOnLocal` default (`true`): a loopback host over plain
 * HTTP is treated as a secure context, without which `Secure` cookies would be
 * untestable and unusable against a local target — the primary way this product
 * is used.
 */
function isSecureContext(url: URL): boolean {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true
  const h = url.hostname.toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]'
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadJar(workspacePath: string, environmentId: string): Promise<CookieJar> {
  return withJarLock(workspacePath, environmentId, async () => {
    const jar = await readJar(workspacePath, environmentId)
    const cleaned = dropExpired(jar.cookies)
    if (cleaned.length !== jar.cookies.length) {
      await writeJar(workspacePath, { environmentId, cookies: cleaned })
    }
    return { environmentId, cookies: cleaned }
  })
}

export async function saveJar(workspacePath: string, jar: CookieJar): Promise<void> {
  await withJarLock(workspacePath, jar.environmentId, () => writeJar(workspacePath, jar))
}

export async function list(workspacePath: string, environmentId: string): Promise<Cookie[]> {
  const jar = await loadJar(workspacePath, environmentId)
  return jar.cookies
}

export async function clear(workspacePath: string, environmentId: string): Promise<void> {
  await withJarLock(workspacePath, environmentId, () => unlinkJar(workspacePath, environmentId))
}

export async function deleteJar(workspacePath: string, environmentId: string): Promise<void> {
  await clear(workspacePath, environmentId)
}

/**
 * Normalize a hand-authored domain. A leading dot is the specification's own
 * spelling for "and its subdomains", and the panel used to store it verbatim,
 * which broke matching in both directions. It is now stripped and its meaning
 * carried by `hostOnly` (REQ-0115 §6.5).
 */
function normalizeAuthoredDomain(cookie: Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'>): {
  domain: string
  hostOnly: boolean
} {
  const raw = (cookie.domain ?? '').trim().toLowerCase()
  if (raw.startsWith('.')) return { domain: raw.slice(1), hostOnly: false }
  return { domain: raw, hostOnly: cookie.hostOnly }
}

/**
 * Create or replace a cookie the user authored.
 *
 * Deliberately **not** origin-validated: the validation added by REQ-0115 answers
 * "is this response entitled to set this cookie?", and a hand-authored cookie has
 * no response and no entitlement question. The author's intent is the authority
 * (REQ-0115 §6.5).
 */
export async function upsert(
  workspacePath: string,
  environmentId: string,
  cookie: Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Cookie> {
  return withJarLock(workspacePath, environmentId, async () => {
    const jar = await readJar(workspacePath, environmentId)
    const now = new Date().toISOString()
    const { domain, hostOnly } = normalizeAuthoredDomain(cookie)
    const incoming = { ...cookie, domain, hostOnly, path: cookie.path || '/' }
    const key = identityKey(incoming.domain, incoming.path, incoming.name)
    const existingIdx = jar.cookies.findIndex((c) => identityKey(c.domain, c.path, c.name) === key)

    let result: Cookie
    if (existingIdx >= 0) {
      const existing = jar.cookies[existingIdx]
      result = {
        ...existing,
        ...incoming,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now
      }
      jar.cookies[existingIdx] = result
    } else {
      result = { ...incoming, id: randomUUID(), createdAt: now, updatedAt: now }
      jar.cookies.push(result)
    }
    await writeJar(workspacePath, { environmentId, cookies: dropExpired(jar.cookies) })
    return result
  })
}

export async function update(
  workspacePath: string,
  environmentId: string,
  cookieId: string,
  changes: Partial<Cookie>
): Promise<Cookie> {
  return withJarLock(workspacePath, environmentId, async () => {
    const jar = await readJar(workspacePath, environmentId)
    const idx = jar.cookies.findIndex((c) => c.id === cookieId)
    if (idx < 0) throw new Error(`[cookie-jar] Cookie not found: ${cookieId}`)
    const merged = { ...jar.cookies[idx], ...changes }
    const { domain, hostOnly } = normalizeAuthoredDomain(merged)
    const updated: Cookie = {
      ...merged,
      domain,
      hostOnly,
      path: merged.path || '/',
      id: jar.cookies[idx].id,
      createdAt: jar.cookies[idx].createdAt,
      updatedAt: new Date().toISOString()
    }
    jar.cookies[idx] = updated
    await writeJar(workspacePath, { environmentId, cookies: dropExpired(jar.cookies) })
    return updated
  })
}

export async function remove(
  workspacePath: string,
  environmentId: string,
  cookieId: string
): Promise<void> {
  await withJarLock(workspacePath, environmentId, async () => {
    const jar = await readJar(workspacePath, environmentId)
    const filtered = jar.cookies.filter((c) => c.id !== cookieId)
    if (filtered.length === 0) {
      await unlinkJar(workspacePath, environmentId)
      return
    }
    await writeJar(workspacePath, { environmentId, cookies: filtered })
  })
}

/**
 * RFC 6265bis §5.5 "leave secure cookies alone" — the one storage rule the
 * reference implementation does **not** provide (verified against the installed
 * version), so it stays ours: a guard in front of the delegation, not a fork.
 *
 * A cookie arriving without `Secure` over an insecure connection may not shadow a
 * stored `Secure` cookie whose name matches, whose domain domain-matches in either
 * direction, and whose path the incoming path path-matches.
 */
function isSecureOverwrite(incoming: LibCookie, requestUrl: URL, stored: Cookie[]): boolean {
  if (incoming.secure) return false
  if (isSecureContext(requestUrl)) return false

  const host = canonicalDomain(requestUrl.hostname) ?? requestUrl.hostname.toLowerCase()
  const incomingDomain = incoming.domain
    ? (canonicalDomain(incoming.domain) ?? incoming.domain.toLowerCase())
    : host
  const incomingPath = incoming.path || defaultPath(requestUrl.pathname || '/')

  return stored.some(
    (s) =>
      s.secure &&
      s.name === incoming.key &&
      (domainMatch(incomingDomain, s.domain, true) === true ||
        domainMatch(s.domain, incomingDomain, true) === true) &&
      pathMatch(incomingPath, s.path)
  )
}

/**
 * RFC 6265 §5.3 step 5: a Domain attribute that is a public suffix is ignored
 * only when it differs from the request host; when it **is** the host, the
 * cookie is stored host-only. The library refuses every Domain without a
 * registrable domain (an IPv4 address, a single-label name such as a compose
 * service, a bare suffix) and never compares it with the host, so this applies
 * the step in front of the delegation: it drops the attribute on `parsed` and
 * returns `true` when the cookie must be stored host-only.
 *
 * `allowSpecialUseDomain` mirrors the jar's setting; a lookup that throws (a
 * bare special-use label) is a Domain the library would refuse too.
 */
function storeHostOnlyIfOwnSuffix(parsed: LibCookie, host: string): boolean {
  if (!parsed.domain || parsed.cdomain() !== host) return false
  let suffix: string | undefined
  try {
    suffix = getPublicSuffix(host, { allowSpecialUseDomain: true })
  } catch {
    suffix = undefined
  }
  if (suffix != null) return false
  parsed.domain = null
  return true
}

/** Best-effort cookie name for reporting a header the parser refused. */
function nameFromRawHeader(header: string): string {
  const eq = header.indexOf('=')
  const raw = eq > 0 ? header.slice(0, eq) : header
  return raw.trim().slice(0, 128)
}

/**
 * Capture the `Set-Cookie` headers of one response.
 *
 * `requestUrl` is the URL of the response that offered them — under a redirect
 * chain, the URL of **that hop**, not the URL the user typed (REQ-0115 §6.4).
 * Getting this wrong attributes a cookie to the wrong host and evaluates the
 * domain validation against the wrong origin.
 *
 * Never throws for a refused cookie: refusal is reported and the remaining
 * headers are still processed.
 */
export async function captureFromResponse(
  workspacePath: string,
  environmentId: string,
  requestUrl: string,
  setCookieHeaders: string[]
): Promise<CookieCaptureResult> {
  const empty: CookieCaptureResult = { accepted: [], rejected: [], crossSiteInsecure: [] }
  if (!setCookieHeaders.length) return empty

  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return empty
  }
  const host = canonicalDomain(url.hostname) ?? url.hostname.toLowerCase()

  return withJarLock(workspacePath, environmentId, async () => {
    const stored = await readJar(workspacePath, environmentId)
    const { jar, previous } = await buildLibJar(stored.cookies)
    const result: CookieCaptureResult = { accepted: [], rejected: [], crossSiteInsecure: [] }
    const acceptedKeys: string[] = []

    for (const header of setCookieHeaders) {
      const parsed = LibCookie.parse(header)
      if (!parsed) {
        result.rejected.push({ name: nameFromRawHeader(header), host, reason: 'MALFORMED' })
        continue
      }
      if (isSecureOverwrite(parsed, url, stored.cookies)) {
        result.rejected.push({ name: parsed.key, host, reason: 'INSECURE_OVERWRITE' })
        continue
      }
      try {
        const toSet = storeHostOnlyIfOwnSuffix(parsed, host) ? parsed : header
        const settled = await jar.setCookie(toSet, requestUrl)
        if (!settled) continue
        acceptedKeys.push(identityKey(settled.domain ?? host, settled.path ?? '/', settled.key))
        // Stored, but a browser would refuse it — report the divergence (§6.6).
        if ((settled.sameSite ?? '').toLowerCase() === 'none' && !settled.secure) {
          result.crossSiteInsecure.push({ name: settled.key, host })
        }
      } catch (err) {
        result.rejected.push({ name: parsed.key, host, reason: classifyRejection(err) })
      }
    }

    const drained = await drainLibJar(jar, previous)
    // A cookie that is already expired when captured replaces the stored one and is
    // then dropped, so the net effect is a deletion and it is not reported as
    // captured — preserved from the pre-REQ-0115 behavior.
    const surviving = dropExpired(drained)
    const accepted = new Set(acceptedKeys)
    result.accepted = surviving.filter((c) => accepted.has(identityKey(c.domain, c.path, c.name)))

    await writeJar(workspacePath, { environmentId, cookies: surviving })
    return result
  })
}

// ── Per-hop session ─────────────────────────────────────────────────────────

/**
 * The synchronous per-hop surface the HTTP client drives.
 *
 * Synchronous on purpose, and this is the constraint that shapes the whole
 * design: the transport's interceptors run inside a dispatch, so there is no
 * point at which a hop can await a file read. The jar is therefore loaded **once**
 * before the send, every hop decides against that in-memory copy, and the result
 * is written **once** afterwards — which is also strictly less I/O than the
 * single-shot path it replaces.
 */
export interface CookieHopHooks {
  /**
   * Cookie header for this hop's URL.
   *
   * `null` means **leave the header alone** — the jar is not in charge of this
   * send (the request set its own `Cookie`, or the jar is off). `''` means the
   * jar *is* in charge and nothing matched, so any value inherited from a
   * previous hop must be dropped. Collapsing the two would silently delete a
   * header the user wrote by hand.
   */
  headerFor(url: string): string | null
  /** Record the `Set-Cookie` headers this hop's response offered. */
  capture(url: string, setCookieHeaders: string[]): void
}

export interface CookieSession extends CookieHopHooks {
  /** Cookies attached, across every hop, with the hop they went to. */
  readonly sent: CookieSnapshot[]
  /**
   * Every cookie the responses **offered**, across every hop — whether or not the
   * jar stored it. This is what the response actually sent, which is observable
   * fact and belongs to the user; `stored` on each entry carries the verdict and
   * `rejected` carries the reason.
   */
  readonly offered: CookieSnapshot[]
  readonly rejected: CookieRejection[]
  readonly crossSiteInsecure: { name: string; host: string }[]
  /** Persist the jar. Resolves to `true` when anything was accepted. */
  flush(): Promise<boolean>
}

/**
 * Open a cookie session for one send. `flush()` must be called even when the
 * send fails, so cookies offered before the failure are not lost.
 */
export interface CookieSessionOptions {
  /**
   * Whether the jar supplies the outgoing `Cookie` header. `false` puts the
   * session in capture-only mode: the header on the request is left exactly as
   * the author wrote it, and the responses are still recorded.
   *
   * The two directions are independent decisions. Choosing what to send says
   * nothing about whether the session a server hands back should be kept, and
   * the workspace already has a dedicated switch — the `disableCookieJar`
   * setting and its per-request marker — for "stay out of this entirely".
   */
  attach?: boolean
}

export async function openCookieSession(
  workspacePath: string,
  environmentId: string,
  options: CookieSessionOptions = {}
): Promise<CookieSession> {
  const attach = options.attach ?? true
  const stored = await loadJar(workspacePath, environmentId)
  const { jar, previous } = await buildLibJar(stored.cookies)
  // Snapshot of what was on disk when the send started — the secure-overwrite
  // guard compares against this, and it is the only thing that guard needs.
  let guardBaseline = stored.cookies
  // Receipt time per identity. The library moves `lastAccessed` — which our
  // `updatedAt` maps to — on every cookie it returns for a send, so a lifetime
  // measured from it would restart on each send instead of on each receipt
  // (RFC 6265 §5.3 step 3). Seeded from disk; overwritten only by a capture.
  const receivedAt = new Map(
    stored.cookies.map((c) => [identityKey(c.domain, c.path, c.name), c.updatedAt])
  )
  // The identities this session set or expired through `Set-Cookie`: the only
  // ones `flush()` writes, so a concurrent send or panel edit is not undone.
  const capturedKeys = new Set<string>()

  const sent: CookieSnapshot[] = []
  const offered: CookieSnapshot[] = []
  const rejected: CookieRejection[] = []
  const crossSiteInsecure: { name: string; host: string }[] = []
  /** Accepted count, kept separately now that `offered` includes refusals. */
  let acceptedCount = 0

  const session: CookieSession = {
    sent,
    offered,
    rejected,
    crossSiteInsecure,

    headerFor(url: string): string | null {
      // Capture-only: the header belongs to the author, so it is not ours to
      // set, clear, or merge into. `null` is the "leave it alone" answer — an
      // empty string would delete what they wrote.
      if (!attach) return null
      let matching: LibCookie[]
      try {
        // Throws on an unparseable URL; the library also applies host-only,
        // path, secure and expiry filtering here, so this is the whole decision.
        matching = jar.getCookiesSync(url)
      } catch {
        // Not "no cookies" — we could not decide, so the header is not ours to
        // touch (see `headerFor`'s contract).
        return null
      }
      for (const lc of matching) {
        const key = identityKey(lc.domain ?? '', lc.path ?? '/', lc.key)
        const rec = fromLibCookie(lc, previous.get(key))
        sent.push(
          snapshotFromRecord({ ...rec, updatedAt: receivedAt.get(key) ?? rec.updatedAt }, url)
        )
      }
      return matching.map((c) => `${c.key}=${c.value}`).join('; ')
    },

    capture(url: string, setCookieHeaders: string[]): void {
      if (!setCookieHeaders.length) return
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return
      }
      const host = canonicalDomain(parsed.hostname) ?? parsed.hostname.toLowerCase()
      const receipt = new Date()

      for (const header of setCookieHeaders) {
        // Recorded before any verdict: the response sent this, which is fact.
        // Whether the jar keeps it is a separate question, answered by `stored`.
        const snapshot = snapshotFromSetCookie(header, url, receipt)
        const incoming = LibCookie.parse(header)
        if (!incoming || !snapshot) {
          rejected.push({ name: nameFromRawHeader(header), host, reason: 'MALFORMED' })
          continue
        }
        offered.push(snapshot)

        if (isSecureOverwrite(incoming, parsed, guardBaseline)) {
          snapshot.stored = false
          rejected.push({ name: incoming.key, host, reason: 'INSECURE_OVERWRITE' })
          continue
        }
        try {
          const hostOnly = storeHostOnlyIfOwnSuffix(incoming, host)
          const settled = jar.setCookieSync(hostOnly ? incoming : header, url)
          if (!settled) {
            snapshot.stored = false
            continue
          }
          snapshot.stored = true
          if (hostOnly) snapshot.hostOnly = true
          acceptedCount++
          const key = identityKey(settled.domain ?? host, settled.path ?? '/', settled.key)
          capturedKeys.add(key)
          receivedAt.set(key, receipt.toISOString())
          const rec = {
            ...fromLibCookie(settled, previous.get(key)),
            updatedAt: receipt.toISOString()
          }
          // The guard must see cookies set earlier in the same chain, or a hop
          // could plant a plain cookie that a later hop then shadows.
          guardBaseline = [...guardBaseline.filter((c) => c.id !== rec.id), rec]
          if ((settled.sameSite ?? '').toLowerCase() === 'none' && !settled.secure) {
            crossSiteInsecure.push({ name: settled.key, host })
          }
        } catch (err) {
          snapshot.stored = false
          rejected.push({ name: incoming.key, host, reason: classifyRejection(err) })
        }
      }
    },

    async flush(): Promise<boolean> {
      if (acceptedCount === 0) return false
      const ours = new Map<string, Cookie>()
      for (const c of await drainLibJar(jar, previous)) {
        const key = identityKey(c.domain, c.path, c.name)
        if (capturedKeys.has(key))
          ours.set(key, { ...c, updatedAt: receivedAt.get(key) ?? c.updatedAt })
      }
      // Re-read under the lock and apply only this session's deltas: what is on
      // disk now may hold another send's captures or a panel edit made after the
      // session opened, and writing the start-of-send snapshot back would undo it.
      await withJarLock(workspacePath, environmentId, async () => {
        const current = await readJar(workspacePath, environmentId)
        const next: Cookie[] = []
        const written = new Set<string>()
        for (const c of current.cookies) {
          const key = identityKey(c.domain, c.path, c.name)
          if (!capturedKeys.has(key)) {
            next.push(c)
            continue
          }
          written.add(key)
          const mine = ours.get(key)
          // The record on disk keeps the identity the panel knows it by.
          if (mine) next.push({ ...mine, id: c.id, createdAt: c.createdAt, source: c.source })
        }
        for (const [key, mine] of ours) {
          if (written.has(key)) continue
          // Gone from disk since the session opened (deleted or cleared): a
          // fresh capture, so it starts a fresh identity.
          next.push(
            previous.has(key)
              ? { ...mine, id: randomUUID(), createdAt: mine.updatedAt, source: 'response' }
              : mine
          )
        }
        await writeJar(workspacePath, { environmentId, cookies: dropExpired(next) })
      })
      return true
    }
  }
  return session
}

export async function getMatchingCookies(
  workspacePath: string,
  environmentId: string,
  requestUrl: string
): Promise<Cookie[]> {
  const jar = await loadJar(workspacePath, environmentId)
  const now = Date.now()
  return jar.cookies.filter((c) => matchesRequest(c, requestUrl, now))
}

export async function getCookieHeaderFor(
  workspacePath: string,
  environmentId: string,
  requestUrl: string
): Promise<string> {
  const matching = await getMatchingCookies(workspacePath, environmentId, requestUrl)
  if (matching.length === 0) return ''
  return matching.map((c) => `${c.name}=${c.value}`).join('; ')
}
