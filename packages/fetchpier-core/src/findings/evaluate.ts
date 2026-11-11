// Passive security findings — the rules.
//
// Pure: no I/O, no clock of its own (`now` is a parameter), no human text. Each
// rule has a *scope* (when it applies, and is counted as applied) and a *firing
// condition* checked only within scope. Evidence names things — a header, a
// cookie, a parameter, a hop origin, a protocol — and never carries a value.

import type { Finding, FindingsEvaluation, FindingsTlsState } from '@shared/types'
import {
  FINDING_RULES,
  severityRank,
  type FindingRuleMeta,
  type ResolvedFindingsSettings
} from '@shared/lib/findings'
import type { TlsFacts } from '../requests/connection-facts'
import type { FindingsExchange } from './types'
import {
  cacheControlDirectives,
  cspHasFrameAncestors,
  hasForwardSecrecy,
  hasVersionToken,
  isExplicitlyShareable,
  isCredentialParameterName,
  isIpLiteral,
  isLoopbackHost,
  mediaType,
  parseHsts,
  parseSetCookie,
  queryParameterNames,
  type SetCookieAttributes
} from './http-facts'

const DAY_MS = 86_400_000
/** 180 days — the minimum HSTS lifetime the rule accepts. */
const HSTS_MIN_MAX_AGE = 15_552_000
const LEGACY_PROTOCOLS: ReadonlySet<string> = new Set(['SSLv2', 'SSLv3', 'TLSv1', 'TLSv1.1'])
const AEAD_CIPHER = /GCM|CCM|CHACHA20|POLY1305/i

type Evidence = Record<string, string>

interface HopCookies {
  origin: string
  https: boolean
  http: boolean
  /** Whether the hop's host is loopback (the transport rules' exemption). */
  loopback: boolean
  /** The hop's cookies, deletions excluded. */
  cookies: SetCookieAttributes[]
}

/** What the rules read, derived once from the exchange. */
interface Context {
  https: boolean
  host: string
  loopback: boolean
  ipLiteral: boolean
  finalOrigin: string
  request: (name: string) => string | undefined
  response: (name: string) => string | undefined
  hasBody: boolean
  carrier?: 'authorization' | 'cookie' | 'auth-scheme'
  tls?: TlsFacts
  verifySsl: boolean
  hops: HopCookies[]
  queryNames: string[]
  apiKeyQueryName?: string
  settings: ResolvedFindingsSettings
  now: Date
}

interface Rule {
  applies: (c: Context) => boolean
  /** One evidence object per finding; empty when the rule does not fire. */
  fire: (c: Context) => Evidence[]
}

const once = (fires: boolean, evidence: Evidence = {}): Evidence[] => (fires ? [evidence] : [])

function lookup(entries: Iterable<[string, string]>): (name: string) => string | undefined {
  const map = new Map<string, string>()
  for (const [k, v] of entries) {
    const key = k.toLowerCase()
    if (!map.has(key)) map.set(key, v)
  }
  return (name) => map.get(name.toLowerCase())
}

const httpsWithTls = (c: Context): boolean => c.https && c.tls !== undefined
const daysUntil = (to: Date, from: Date): number =>
  Math.ceil((to.getTime() - from.getTime()) / DAY_MS)
const isExpired = (c: Context): boolean =>
  c.tls !== undefined && c.tls.certificate.validTo.getTime() <= c.now.getTime()
const hstsInScope = (c: Context): boolean => c.https && !c.ipLiteral
const isHtml = (c: Context): boolean => mediaType(c.response('content-type')) === 'text/html'
const isTrue = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'true'
const liveCookies = (c: Context): Array<{ hop: HopCookies; cookie: SetCookieAttributes }> =>
  c.hops.flatMap((hop) => hop.cookies.map((cookie) => ({ hop, cookie })))

const VERSION_HEADERS = ['Server', 'X-Powered-By'] as const
const ALWAYS_VERSION_HEADERS = ['X-AspNet-Version', 'X-AspNetMvc-Version'] as const

const RULES: Readonly<Record<string, Rule>> = {
  'transport.plaintext': {
    applies: (c) => !c.loopback,
    fire: (c) => once(!c.https && c.carrier === undefined)
  },
  'transport.plaintext-credentials': {
    applies: (c) => !c.loopback,
    fire: (c) => (!c.https && c.carrier ? [{ carrier: c.carrier }] : [])
  },
  // Coexists with `transport.plaintext` by owner decision: a server moving a
  // secure exchange to plain text and a response arriving in plain text are two
  // facts. One finding per https → http transition.
  'transport.https-downgrade': {
    applies: (c) => c.hops.length >= 2 && c.hops.some((h) => h.https),
    fire: (c) => {
      const out: Evidence[] = []
      for (let i = 0; i + 1 < c.hops.length; i++) {
        const from = c.hops[i]
        const to = c.hops[i + 1]
        if (from.https && to.http && !to.loopback) out.push({ from: from.origin, to: to.origin })
      }
      return out
    }
  },
  'tls.verification-disabled': {
    applies: (c) => c.https,
    fire: (c) => once(!c.verifySsl)
  },
  'tls.untrusted-certificate': {
    applies: httpsWithTls,
    fire: (c) => {
      const tls = c.tls!
      if (c.verifySsl || tls.authorized) return []
      // Superseded by `tls.certificate-expired` when the expiry is the only error.
      if (isExpired(c) && tls.authorizationError === 'CERT_HAS_EXPIRED') return []
      return [{ error: tls.authorizationError ?? 'UNKNOWN' }]
    }
  },
  'tls.legacy-protocol': {
    applies: httpsWithTls,
    fire: (c) => (LEGACY_PROTOCOLS.has(c.tls!.protocol) ? [{ protocol: c.tls!.protocol }] : [])
  },
  'tls.non-aead-cipher': {
    applies: httpsWithTls,
    fire: (c) => (AEAD_CIPHER.test(c.tls!.cipher) ? [] : [{ cipher: c.tls!.cipher }])
  },
  'tls.no-forward-secrecy': {
    applies: httpsWithTls,
    fire: (c) =>
      hasForwardSecrecy(c.tls!.protocol, c.tls!.cipher) ? [] : [{ cipher: c.tls!.cipher }]
  },
  'tls.certificate-expired': {
    applies: httpsWithTls,
    fire: (c) =>
      isExpired(c)
        ? [{ daysAgo: String(Math.max(0, daysUntil(c.now, c.tls!.certificate.validTo))) }]
        : []
  },
  'tls.certificate-expiring': {
    applies: httpsWithTls,
    fire: (c) => {
      if (isExpired(c)) return []
      const daysLeft = daysUntil(c.tls!.certificate.validTo, c.now)
      return daysLeft <= c.settings.certExpiryWarnDays ? [{ daysLeft: String(daysLeft) }] : []
    }
  },
  'tls.weak-key': {
    applies: httpsWithTls,
    fire: (c) => {
      const { keyType, bits } = c.tls!.certificate
      if (bits === undefined) return []
      const weak =
        ((keyType === 'rsa' || keyType === 'dsa') && bits < 2048) ||
        (keyType === 'ec' && bits < 256)
      return weak ? [{ keyType, bits: String(bits) }] : []
    }
  },
  'headers.hsts-missing': {
    applies: hstsInScope,
    fire: (c) => {
      const hsts = parseHsts(c.response('strict-transport-security'))
      return once(!hsts || !hsts.valid)
    }
  },
  'headers.hsts-short-max-age': {
    applies: hstsInScope,
    fire: (c) => {
      const hsts = parseHsts(c.response('strict-transport-security'))
      return hsts?.valid && hsts.maxAge! < HSTS_MIN_MAX_AGE ? [{ maxAge: String(hsts.maxAge) }] : []
    }
  },
  'headers.nosniff-missing': {
    applies: (c) => c.hasBody,
    fire: (c) =>
      once(
        (c.response('x-content-type-options') ?? '').split(',')[0].trim().toLowerCase() !==
          'nosniff'
      )
  },
  'headers.csp-missing': {
    applies: isHtml,
    fire: (c) => once(!(c.response('content-security-policy') ?? '').trim())
  },
  'headers.frame-protection-missing': {
    applies: isHtml,
    fire: (c) =>
      once(
        !cspHasFrameAncestors(c.response('content-security-policy')) &&
          !(c.response('x-frame-options') ?? '').trim()
      )
  },
  'headers.cors-wildcard-credentials': {
    applies: () => true,
    fire: (c) =>
      once(
        (c.response('access-control-allow-origin') ?? '').trim() === '*' &&
          isTrue(c.response('access-control-allow-credentials'))
      )
  },
  'headers.cors-reflected-origin': {
    applies: (c) => !!c.request('origin')?.trim(),
    fire: (c) => {
      const acao = (c.response('access-control-allow-origin') ?? '').trim()
      const origin = c.request('origin')!.trim()
      return once(
        acao !== '*' &&
          acao.toLowerCase() === origin.toLowerCase() &&
          isTrue(c.response('access-control-allow-credentials'))
      )
    }
  },
  'headers.cors-null-origin': {
    applies: () => true,
    fire: (c) =>
      once((c.response('access-control-allow-origin') ?? '').trim().toLowerCase() === 'null')
  },
  'headers.version-disclosure': {
    applies: () => true,
    fire: (c) =>
      [
        ...VERSION_HEADERS.filter((h) => hasVersionToken(c.response(h) ?? '')),
        ...ALWAYS_VERSION_HEADERS.filter((h) => c.response(h) !== undefined)
      ].map((header) => ({ header }))
  },
  'cookies.missing-secure': {
    applies: (c) => c.hops.some((h) => h.https && h.cookies.length > 0),
    fire: (c) =>
      liveCookies(c)
        .filter(({ hop, cookie }) => hop.https && !cookie.secure)
        .map(({ hop, cookie }) => ({ cookie: cookie.name, hop: hop.origin }))
  },
  'cookies.missing-httponly': {
    applies: (c) => c.hops.some((h) => h.cookies.length > 0),
    fire: (c) =>
      liveCookies(c)
        .filter(({ cookie }) => !cookie.httpOnly)
        .map(({ hop, cookie }) => ({ cookie: cookie.name, hop: hop.origin }))
  },
  'auth.credentials-in-query': {
    applies: () => true,
    fire: (c) => {
      const seen = new Set<string>()
      const out: Evidence[] = []
      for (const name of c.queryNames) {
        if (seen.has(name)) continue
        const scheme =
          c.apiKeyQueryName !== undefined && name.toLowerCase() === c.apiKeyQueryName.toLowerCase()
        if (scheme || isCredentialParameterName(name)) {
          seen.add(name)
          out.push({ parameter: name })
        }
      }
      return out
    }
  },
  'cache.sensitive-cacheable': {
    applies: (c) => c.carrier !== undefined,
    fire: (c) => {
      const d = cacheControlDirectives(c.response('cache-control'))
      return once(!d.has('no-store') && !d.has('private'))
    }
  },
  // The final response's own cookies (its hop is the last one); one finding per
  // response, since the fix is its caching policy, not any single cookie.
  'cache.set-cookie-cacheable': {
    applies: (c) => finalCookies(c).length > 0,
    fire: (c) =>
      isExplicitlyShareable(c.response('cache-control'), c.response('expires'), c.now)
        ? [{ cookies: [...new Set(finalCookies(c).map((k) => k.name))].join(', ') }]
        : []
  }
}

function finalCookies(c: Context): SetCookieAttributes[] {
  return c.hops[c.hops.length - 1]?.cookies ?? []
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function buildContext(
  ex: FindingsExchange,
  settings: ResolvedFindingsSettings,
  now: Date
): Context {
  const url = new URL(ex.finalUrl)
  const https = url.protocol === 'https:'
  const request = lookup(ex.requestHeaders)
  const response = lookup(Object.entries(ex.response.headers))
  const queryNames = queryParameterNames(ex.finalUrl)

  const apiKey = ex.auth?.type === 'api-key' ? ex.auth : undefined
  const apiKeyQueryName = apiKey?.location === 'query' && apiKey.key ? apiKey.key : undefined
  let carrier: Context['carrier']
  if (request('authorization') !== undefined) carrier = 'authorization'
  else if (request('cookie') !== undefined) carrier = 'cookie'
  else if (apiKey?.location === 'header' && apiKey.key && request(apiKey.key) !== undefined) {
    carrier = 'auth-scheme'
  } else if (
    apiKeyQueryName !== undefined &&
    queryNames.some((n) => n.toLowerCase() === apiKeyQueryName.toLowerCase())
  ) {
    carrier = 'auth-scheme'
  }

  const hops: HopCookies[] = ex.hops.map((hop) => ({
    origin: originOf(hop.url),
    https: hop.url.toLowerCase().startsWith('https:'),
    http: hop.url.toLowerCase().startsWith('http:'),
    loopback: hostOf(hop.url) !== null && isLoopbackHost(hostOf(hop.url)!),
    cookies: hop.setCookie
      .map((raw) => parseSetCookie(raw, now))
      .filter((c): c is SetCookieAttributes => c !== null && !c.deletion)
  }))

  return {
    https,
    host: url.hostname,
    loopback: isLoopbackHost(url.hostname),
    ipLiteral: isIpLiteral(url.hostname),
    finalOrigin: url.origin,
    request,
    response,
    hasBody: ex.response.hasBody,
    ...(carrier ? { carrier } : {}),
    ...(ex.tls ? { tls: ex.tls } : {}),
    verifySsl: ex.verifySsl,
    hops,
    queryNames,
    ...(apiKeyQueryName !== undefined ? { apiKeyQueryName } : {}),
    settings,
    now
  }
}

/**
 * Evaluate one exchange. `rulesApplied` counts the enabled rules whose scope held;
 * items are ordered by severity (high → info), then rule id.
 */
export function evaluateFindings(
  exchange: FindingsExchange,
  settings: ResolvedFindingsSettings,
  now: Date
): Extract<FindingsEvaluation, { status: 'evaluated' }> {
  const c = buildContext(exchange, settings, now)
  const tls: FindingsTlsState = !c.https ? 'not-applicable' : c.tls ? 'captured' : 'unavailable'
  const items: Finding[] = []
  let rulesApplied = 0
  for (const meta of FINDING_RULES as readonly FindingRuleMeta[]) {
    if (settings.disabledRules.has(meta.id)) continue
    const rule = RULES[meta.id]
    if (!rule || !rule.applies(c)) continue
    rulesApplied += 1
    for (const evidence of rule.fire(c)) {
      items.push({ ruleId: meta.id, severity: meta.severity, category: meta.category, evidence })
    }
  }
  items.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) || a.ruleId.localeCompare(b.ruleId)
  )
  return { status: 'evaluated', items, rulesApplied, tls, finalOrigin: c.finalOrigin }
}
