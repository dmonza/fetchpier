/**
 * Proxy routing from a run's flag and the conventional proxy environment
 * variables (CLI readiness for CI). Pure — no I/O, no network.
 *
 * Precedence: an explicit proxy (the `--proxy` flag) applies to every target;
 * otherwise `HTTPS_PROXY` for https targets and `HTTP_PROXY` for http targets
 * (uppercase wins over lowercase). `NO_PROXY` excludes targets from either.
 * `noProxy` ignores the three variables entirely. The desktop does not use this:
 * it keeps its single app-settings proxy.
 */

import type { ProxyConfig } from '@shared/types'
import { CoreError } from '../shared/context'

export type ProxySource = '--proxy' | 'HTTPS_PROXY' | 'HTTP_PROXY'

export interface ProxyRoutingInput {
  /** Explicit proxy for the run (the CLI's `--proxy`). */
  flag?: string
  /** Ignore the proxy environment variables (the CLI's `--no-proxy`). */
  noProxy?: boolean
  /** Environment to read `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` from. */
  env?: NodeJS.ProcessEnv
}

export interface ProxyRouting {
  /** The proxy to use for `url`, or `undefined` to connect directly. */
  proxyFor(url: string): ProxyConfig | undefined
  /**
   * What the run will use, for display — never carries credentials. When only
   * the variables are set, the https one is described (the common CI case),
   * falling back to the http one.
   */
  active?: { display: string; source: ProxySource; noProxy?: string }
}

function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name] ?? env[name.toLowerCase()]
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * An unusable proxy, named by where it came from. The value is never part of the
 * message (nor of `details`): it is printed in CI logs, and a proxy URL routinely
 * carries the username and password.
 */
function invalidProxy(source: ProxySource, reason: string): CoreError {
  return new CoreError('PROXY_INVALID', `Invalid proxy URL from ${source}: ${reason}`, { source })
}

function decodeCredential(value: string, source: ProxySource): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A `URIError` is not a contractual failure: left alone it surfaced as an
    // internal error (exit 255 with a stack trace) instead of an unusable proxy.
    throw invalidProxy(source, 'the credentials contain an invalid percent escape')
  }
}

function parseProxy(raw: string, source: ProxySource): ProxyConfig {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw invalidProxy(source, 'not a valid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // The protocol carries no credential only when the value spells out
    // `<scheme>://`. Without it the parser reads everything up to the first `:`
    // as the scheme, which for `user:pass@host:port` is the username.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      throw invalidProxy(source, `"${u.protocol}" is not supported (use http:// or https://)`)
    }
    throw invalidProxy(source, 'the value has no http:// or https:// scheme')
  }
  const username = decodeCredential(u.username, source)
  const password = decodeCredential(u.password, source)
  u.username = ''
  u.password = ''
  return { enabled: true, url: `${u.protocol}//${u.host}`, username, password }
}

/**
 * Whether `url`'s host is excluded by a `NO_PROXY` list: comma-separated hosts,
 * domain suffixes (with or without a leading dot), `host:port`, or `*`. An IPv6
 * literal is accepted bare (`::1`), bracketed (`[::1]`) or with a port
 * (`[::1]:3000`).
 */
export function matchesNoProxy(url: string, noProxyList: string | undefined): boolean {
  if (!noProxyList) return false
  let host: string
  let port: string
  try {
    const u = new URL(url)
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    port = u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    return false
  }
  for (const rawEntry of noProxyList.split(',')) {
    const entry = rawEntry.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    let entryHost = entry
    let entryPort: string | undefined
    if (entry.startsWith('[')) {
      // A bracketed IPv6 literal, with or without a port.
      const bracketed = entry.match(/^\[([^\]]*)\](?::(\d+))?$/)
      if (!bracketed) continue
      entryHost = bracketed[1]
      entryPort = bracketed[2]
    } else if (entry.indexOf(':') === entry.lastIndexOf(':')) {
      // At most one `:` — `host:port`. More than one is a bare IPv6 address,
      // which carries no port.
      const portMatch = entry.match(/^(.*):(\d+)$/)
      if (portMatch) {
        entryHost = portMatch[1]
        entryPort = portMatch[2]
      }
    }
    if (entryPort && entryPort !== port) continue
    entryHost = entryHost.replace(/^\*?\./, '')
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true
  }
  return false
}

/** Build the run's proxy routing. Throws `PROXY_INVALID` before anything is sent. */
export function resolveProxyRouting(input: ProxyRoutingInput): ProxyRouting {
  const env = input.env ?? {}
  if (input.flag !== undefined && input.noProxy) {
    throw new CoreError('PROXY_INVALID', '--proxy and --no-proxy cannot be used together', {
      source: '--proxy'
    })
  }

  const flag = input.flag?.trim()
  const explicit = flag ? parseProxy(flag, '--proxy') : undefined
  const useEnv = !input.noProxy
  const httpsRaw = useEnv ? readVar(env, 'HTTPS_PROXY') : undefined
  const httpRaw = useEnv ? readVar(env, 'HTTP_PROXY') : undefined
  // Parse eagerly: an invalid variable is fatal before any request is sent, even
  // when the run would only reach targets of the other scheme.
  const httpsProxy = httpsRaw ? parseProxy(httpsRaw, 'HTTPS_PROXY') : undefined
  const httpProxy = httpRaw ? parseProxy(httpRaw, 'HTTP_PROXY') : undefined
  const noProxyList = useEnv ? readVar(env, 'NO_PROXY') : undefined

  const proxyFor = (url: string): ProxyConfig | undefined => {
    if (matchesNoProxy(url, noProxyList)) return undefined
    if (explicit) return explicit
    const isHttps = /^https:/i.test(url.trim())
    return isHttps ? httpsProxy : httpProxy
  }

  const chosen: ProxyRouting['active'] = explicit
    ? { display: explicit.url, source: '--proxy' }
    : httpsProxy
      ? { display: httpsProxy.url, source: 'HTTPS_PROXY' }
      : httpProxy
        ? { display: httpProxy.url, source: 'HTTP_PROXY' }
        : undefined
  // The exclusion list is part of what the run will do: without it a
  // description reads as if every request used the proxy.
  const active: ProxyRouting['active'] =
    chosen && noProxyList ? { ...chosen, noProxy: noProxyList } : chosen

  return { proxyFor, ...(active ? { active } : {}) }
}
