import { Agent, ProxyAgent, Dispatcher, interceptors, errors as undiciErrors } from 'undici'
import { Readable } from 'node:stream'
import type { HttpRequest, HttpResponse, ProxyConfig, WorkspaceHttpSettings } from '@shared/types'
import { DEFAULT_USER_AGENT } from '@shared/types'
import { hasHeader, headersToUndiciArray, removeHeaders } from '@shared/lib/headers'
import type { CookieHopHooks } from './cookie-jar'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { CoreError } from '../shared/context'
import { describeError } from '../shared/describe-error'

/**
 * Methods for which RFC 9110 / RFC 7231 say a payload body is expected.
 * Undici's HTTP/2 client only allows buffer bodies for these methods — see
 * {@link prepareBodyForUndici} for why we sidestep that.
 */
const METHODS_EXPECTING_PAYLOAD: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH'])

/**
 * Workaround for undici v8.x H2 client (`client-h2.js:writeBuffer`):
 *
 *   assert(contentLength === body.byteLength, 'buffer body must have content length')
 *
 * Undici converts string bodies to `Buffer` internally, then nulls
 * `contentLength` whenever the method does NOT expect a payload (anything
 * other than POST/PUT/PATCH). The buffer write path then trips the assertion
 * and crashes the IPC handler.
 *
 * The stream write path (`writeStream`) does not have that assertion, so we
 * coerce non-empty bodies on bodyless methods (GET/HEAD/DELETE/OPTIONS/etc.)
 * into a one-shot `Readable`. Behavior over HTTP/1.1 is unchanged because the
 * H1 client accepts stream bodies natively.
 *
 * Empty / missing bodies are passed through as `null` so undici still emits
 * the right `Content-Length: 0` semantics on payload methods.
 *
 * `Buffer` bodies pass through unchanged for payload-bearing methods (binary
 * file uploads under REQ-0065).
 */
function prepareBodyForUndici(
  method: string,
  body: string | Buffer | undefined | null
): string | Buffer | Readable | null {
  if (body == null) return null
  if (typeof body === 'string') {
    if (body === '') return null
    if (METHODS_EXPECTING_PAYLOAD.has(method.toUpperCase())) return body
    return Readable.from(Buffer.from(body))
  }
  // Buffer body. Empty buffer behaves like missing body.
  if (body.byteLength === 0) return null
  if (METHODS_EXPECTING_PAYLOAD.has(method.toUpperCase())) return body
  return Readable.from(body)
}

/** Maps common HTTP status codes to their standard reason phrases. */
const STATUS_TEXT: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

/** TLS material attached to a single send (CAs to add, client cert to present). */
export interface ResolvedTlsMaterial {
  ca?: Buffer[]
  cert?: Buffer
  key?: Buffer
  pfx?: Buffer
  passphrase?: string
}

export interface SendOptions {
  /** AbortController signal for cancellation. */
  signal?: AbortSignal
  /** Optional proxy configuration. Used only if `proxy.enabled` and `proxy.url` are set. */
  proxy?: ProxyConfig
  /** Fully resolved transport settings — applied to the dispatcher and request. */
  settings?: WorkspaceHttpSettings
  /** Optional TLS material (additional CAs and/or client certificate) for this send. */
  tls?: ResolvedTlsMaterial
  /**
   * Raw buffer body for binary requests (REQ-0065). When set, overrides
   * `httpRequest.body`. Passed through to undici verbatim — no variable
   * interpolation, no charset transcoding.
   */
  binaryBody?: Buffer
  /**
   * Pre-encoded multipart/form-data body (REQ-0066). When set, overrides
   * both `httpRequest.body` and `binaryBody`. The encoder generates the
   * full `Content-Type: multipart/form-data; boundary=...` header — the
   * client injects it before send and warns + replaces if the user has set
   * one manually (REQ §5.2 rule 9).
   */
  multipartBody?: {
    contentType: string
    body: Buffer
  }
  /**
   * REQ-0115 — per-hop cookie jar. When present, the client owns the `Cookie`
   * header on every hop of a redirect chain and reports back every `Set-Cookie`
   * each hop offered. The caller must **not** also set a `Cookie` header: pass
   * this or set the header, never both.
   */
  cookies?: CookieHopHooks
}

export interface SendResult {
  response: HttpResponse
  /** Raw `Set-Cookie` header values (one entry per header), preserving commas. */
  rawSetCookie: string[]
}

/**
 * Creates a redirect interceptor that optionally strips the `Authorization`
 * header when the redirect points to a host different from the original request.
 * Falls back to the plain `redirect` interceptor when `followAuthorization` is true.
 */
function redirectInterceptorWithAuthStripping(
  maxRedirections: number,
  followAuthorization: boolean
): (dispatch: Dispatcher['dispatch']) => Dispatcher['dispatch'] {
  if (maxRedirections <= 0) {
    // No interception needed — the interceptor only forwards.
    return (dispatch) => dispatch
  }
  if (followAuthorization) {
    return interceptors.redirect({ maxRedirections })
  }

  // Custom interceptor: when a redirect crosses hosts, remove Authorization.
  return (dispatch) => (opts, handler) => {
    let originalHost: string | undefined
    try {
      const origin =
        typeof opts.origin === 'string'
          ? opts.origin
          : opts.origin instanceof URL
            ? opts.origin.toString()
            : undefined
      if (origin) originalHost = new URL(origin).host
    } catch {
      // ignore
    }

    const inner = interceptors.redirect({ maxRedirections })((nextOpts, nextHandler) => {
      let targetHost: string | undefined
      try {
        const origin =
          typeof nextOpts.origin === 'string'
            ? nextOpts.origin
            : nextOpts.origin instanceof URL
              ? nextOpts.origin.toString()
              : undefined
        if (origin) targetHost = new URL(origin).host
      } catch {
        // ignore
      }
      if (originalHost && targetHost && originalHost !== targetHost) {
        const headers = nextOpts.headers
        if (headers) {
          if (Array.isArray(headers)) {
            const filtered: string[] = []
            for (let i = 0; i < headers.length; i += 2) {
              if (headers[i].toLowerCase() !== 'authorization') {
                filtered.push(headers[i], headers[i + 1])
              }
            }
            nextOpts = { ...nextOpts, headers: filtered }
          } else if (typeof headers === 'object') {
            const filtered: Record<string, string | string[] | undefined> = {}
            for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
              if (k.toLowerCase() !== 'authorization') {
                filtered[k] = v as string | string[] | undefined
              }
            }
            nextOpts = { ...nextOpts, headers: filtered }
          }
        }
      }
      return dispatch(nextOpts, nextHandler)
    })
    return inner(opts, handler)
  }
}

/** The absolute URL of one hop, rebuilt from the dispatch options. */
function hopUrl(opts: Dispatcher.DispatchOptions): string | null {
  try {
    const origin =
      typeof opts.origin === 'string'
        ? opts.origin
        : opts.origin instanceof URL
          ? opts.origin.toString()
          : undefined
    if (!origin) return null
    return new URL(opts.path ?? '/', origin).toString()
  } catch {
    return null
  }
}

/** Replace any `Cookie` header on these dispatch options with `value` (or drop it). */
function withCookieHeader(
  opts: Dispatcher.DispatchOptions,
  value: string
): Dispatcher.DispatchOptions {
  const headers = opts.headers
  if (Array.isArray(headers)) {
    const kept: string[] = []
    for (let i = 0; i < headers.length; i += 2) {
      if (headers[i].toLowerCase() !== 'cookie') kept.push(headers[i], headers[i + 1])
    }
    if (value) kept.push('Cookie', value)
    return { ...opts, headers: kept }
  }
  const kept: Record<string, string | string[] | undefined> = {}
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() !== 'cookie') kept[k] = v as string | string[] | undefined
    }
  }
  if (value) kept.Cookie = value
  return { ...opts, headers: kept }
}

/** Pull the raw `Set-Cookie` values out of a response header bag. */
function rawSetCookieFrom(headers: unknown): string[] {
  if (!headers || typeof headers !== 'object') return []
  const bag = headers as Record<string, string | string[] | undefined>
  const found = bag['set-cookie'] ?? bag['Set-Cookie']
  if (!found) return []
  return Array.isArray(found) ? found : [found]
}

/**
 * REQ-0115 — the cookie jar, applied **per hop**.
 *
 * Composed *inside* the redirect interceptor (see `buildAgent`), so the transport
 * calls it once per hop, with that hop's options and **after** its cross-origin
 * header clean has run. That ordering is what makes this work: the transport
 * unconditionally strips `Cookie` when a redirect changes origin, and this puts
 * back only the cookies that match the new host — so nothing crosses a host
 * boundary that was not scoped to the destination, while a login that hands its
 * session over on a `302` finally works.
 *
 * Wrapping the handler is what exposes the intermediate responses: the transport
 * discards a 3xx body, but its headers still travel the handler chain, and this
 * sits below the redirect handler that would otherwise swallow them.
 */
function cookieInterceptor(
  hooks: CookieHopHooks
): (dispatch: Dispatcher['dispatch']) => Dispatcher['dispatch'] {
  return (dispatch) => (opts, handler) => {
    const url = hopUrl(opts)
    if (!url) return dispatch(opts, handler)

    // `null` means the jar is not in charge of this send — leave whatever header
    // is there untouched. Treating it as an empty string would delete a `Cookie`
    // header the user set by hand.
    const decided = hooks.headerFor(url)
    const nextOpts = decided === null ? opts : withCookieHeader(opts, decided)
    const observed: Dispatcher.DispatchHandler = {
      onRequestStart: (c, ctx) => handler.onRequestStart?.(c, ctx),
      onRequestUpgrade: (c, status, headers, socket) =>
        handler.onRequestUpgrade?.(c, status, headers, socket),
      onResponseStart: (c, status, headers, statusMessage) => {
        hooks.capture(url, rawSetCookieFrom(headers))
        return handler.onResponseStart?.(c, status, headers, statusMessage)
      },
      onResponseData: (c, chunk) => handler.onResponseData?.(c, chunk),
      onResponseEnd: (c, trailers) => handler.onResponseEnd?.(c, trailers),
      onResponseError: (c, err) => handler.onResponseError?.(c, err)
    }
    return dispatch(nextOpts, observed)
  }
}

function buildAgent(
  settings: WorkspaceHttpSettings,
  isHttps: boolean,
  proxy?: ProxyConfig,
  tlsMaterial?: ResolvedTlsMaterial,
  cookies?: CookieHopHooks
): Dispatcher {
  // HTTP/2 is only meaningful over HTTPS. Warn and fall back to HTTP/1.1 for plain HTTP.
  let allowH2: boolean
  if (settings.httpVersion === 'http2') {
    if (!isHttps) {
      console.warn(
        '[http.client] httpVersion=http2 requested over plain HTTP — falling back to HTTP/1.1'
      )
      allowH2 = false
    } else {
      allowH2 = true
    }
  } else if (settings.httpVersion === 'auto') {
    // Let undici negotiate via ALPN for HTTPS.
    allowH2 = isHttps
  } else {
    allowH2 = false
  }

  // Custom CAs and client cert material apply even when `verifySsl: false`
  // (REQ-0053 §4.5). The two are independent settings.
  const tlsOptions: Record<string, unknown> = {
    rejectUnauthorized: settings.verifySsl
  }
  if (tlsMaterial?.ca && tlsMaterial.ca.length > 0) tlsOptions.ca = tlsMaterial.ca
  if (tlsMaterial?.cert) tlsOptions.cert = tlsMaterial.cert
  if (tlsMaterial?.key) tlsOptions.key = tlsMaterial.key
  if (tlsMaterial?.pfx) tlsOptions.pfx = tlsMaterial.pfx
  if (tlsMaterial?.passphrase) tlsOptions.passphrase = tlsMaterial.passphrase

  const base: Dispatcher =
    proxy && proxy.enabled && proxy.url.trim()
      ? new ProxyAgent({
          uri: proxy.url.trim(),
          token:
            proxy.username.trim() || proxy.password
              ? 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
              : undefined,
          requestTls: tlsOptions,
          proxyTls: tlsOptions
        })
      : new Agent({ allowH2, connect: tlsOptions })

  const maxRedirections = settings.followRedirects ? settings.maxRedirects : 0

  // Order matters. `compose` applies left to right, and each interceptor wraps the
  // previous one — so the LAST entry is the outermost and runs first. The redirect
  // interceptor must be outermost (it drives the loop); the cookie interceptor
  // must be inside it, where it is re-entered once per hop.
  const chain: ((dispatch: Dispatcher['dispatch']) => Dispatcher['dispatch'])[] = []
  if (cookies) chain.push(cookieInterceptor(cookies))
  if (maxRedirections > 0) {
    chain.push(
      redirectInterceptorWithAuthStripping(maxRedirections, settings.followAuthorizationOnRedirect)
    )
  }
  if (chain.length === 0) return base
  return base.compose(chain)
}

function normalizeProtocol(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/**
 * Splits a request URL into the wire target undici needs (`origin` + `path`),
 * preserving the query string **verbatim**.
 *
 * REQ-0081: the query is assembled and encoded upstream in `execute()` —
 * contextually when `encodeUrl` is on, raw when off. `new URL()` runs only on the
 * base (origin + path; path handling is unchanged, §2.2) so it never re-normalizes
 * the query: the exact bytes the core produced reach the wire (this is what makes
 * the `encodeUrl: off` escape hatch a true raw passthrough).
 */
function buildRequestTarget(rawUrl: string): { origin: string; path: string; protocol: string } {
  const normalized = normalizeProtocol(rawUrl)
  const qIdx = normalized.indexOf('?')
  const beforeQuery = qIdx === -1 ? normalized : normalized.slice(0, qIdx)
  const rawQuery = qIdx === -1 ? '' : normalized.slice(qIdx + 1)
  const u = new URL(beforeQuery)
  return {
    origin: u.origin,
    protocol: u.protocol,
    path: u.pathname + (rawQuery ? `?${rawQuery}` : '')
  }
}

/**
 * Sends an HTTP request from the main process (no CORS restrictions).
 * Measures round-trip time and captures status, headers, body, and size.
 */
export async function sendRequest(
  httpRequest: HttpRequest,
  options: SendOptions = {}
): Promise<HttpResponse> {
  const { response } = await sendRequestWithRaw(httpRequest, options)
  return response
}

export async function sendRequestWithRaw(
  httpRequest: HttpRequest,
  options: SendOptions = {}
): Promise<SendResult> {
  const { signal, proxy, settings = DEFAULT_WORKSPACE_HTTP_SETTINGS } = options

  const target = buildRequestTarget(httpRequest.url)
  const isHttps = target.protocol === 'https:'
  const agent = buildAgent(settings, isHttps, proxy, options.tls, options.cookies)

  const start = performance.now()

  // When the request carries the ordered `headerList`, send undici the
  // positional array form (`[name, value, …]`) so order **and** duplicate names
  // survive on the wire — the object form would collapse same-name entries.
  // Otherwise fall back to the lossy record (legacy / importer-built requests).
  let headers: Record<string, string> | string[]
  if (httpRequest.headerList) {
    let list = [...httpRequest.headerList]
    if (!hasHeader(list, 'user-agent')) {
      list.push({ name: 'User-Agent', value: DEFAULT_USER_AGENT })
    }
    if (options.multipartBody) {
      // Encoder-generated Content-Type wins; warn + replace a manual one
      // (REQ §5.2 rule 9, REQ §7.2). The encoder owns the boundary header.
      if (hasHeader(list, 'content-type')) {
        console.warn(
          '[http.client] Ignoring user-set Content-Type — multipart encoder owns the boundary header.'
        )
        list = removeHeaders(list, 'content-type')
      }
      list.push({ name: 'Content-Type', value: options.multipartBody.contentType })
    }
    headers = headersToUndiciArray(list)
  } else {
    const hasUserAgent = Object.keys(httpRequest.headers).some(
      (k) => k.toLowerCase() === 'user-agent'
    )
    let record = hasUserAgent
      ? httpRequest.headers
      : { ...httpRequest.headers, 'User-Agent': DEFAULT_USER_AGENT }

    if (options.multipartBody) {
      // Find any existing Content-Type variant in the headers map and replace
      // its value with ours — preserving the original key casing for the rest.
      const existingKey = Object.keys(record).find((k) => k.toLowerCase() === 'content-type')
      if (existingKey) {
        console.warn(
          '[http.client] Ignoring user-set Content-Type — multipart encoder owns the boundary header.'
        )
        record = { ...record, [existingKey]: options.multipartBody.contentType }
      } else {
        record = { ...record, 'Content-Type': options.multipartBody.contentType }
      }
    }
    headers = record
  }

  try {
    const effectiveBody: string | Buffer | undefined | null =
      options.multipartBody?.body ?? options.binaryBody ?? httpRequest.body

    const response = await agent.request({
      origin: target.origin,
      path: target.path,
      method: httpRequest.method as
        'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE',
      headers,
      body: prepareBodyForUndici(httpRequest.method, effectiveBody),
      signal: signal ?? null
    })

    const responseBody = await response.body.text()
    const timingMs = performance.now() - start
    const sizeBytes = Buffer.byteLength(responseBody, 'utf-8')

    // Normalise headers: undici returns them as string | string[] per field.
    // Capture raw Set-Cookie as a separate array before joining, since comma
    // joins corrupt date attributes inside the cookie header.
    const normalisedHeaders: Record<string, string> = {}
    const rawSetCookie: string[] = []
    for (const [key, value] of Object.entries(response.headers)) {
      if (value === undefined) continue
      if (key.toLowerCase() === 'set-cookie') {
        if (Array.isArray(value)) rawSetCookie.push(...value)
        else rawSetCookie.push(value)
      }
      normalisedHeaders[key] = Array.isArray(value) ? value.join(', ') : value
    }

    return {
      response: {
        status: response.statusCode,
        statusText: STATUS_TEXT[response.statusCode] ?? String(response.statusCode),
        headers: normalisedHeaders,
        body: responseBody,
        timingMs: Math.round(timingMs),
        sizeBytes
      },
      rawSetCookie
    }
  } catch (err) {
    if (err instanceof undiciErrors.RequestAbortedError) {
      throw new Error('Request cancelled', { cause: err })
    }
    // A contractual failure keeps its identity: `execute` re-throws a CoreError
    // so it stays fatal instead of degrading into an ordinary failed request,
    // and wrapping one here would erase its `code`.
    if (err instanceof CoreError) throw err
    // An error that already says something is handed on untouched — the
    // runtime's own sentence beats anything composed from its parts.
    if (err instanceof Error && err.message.trim()) throw err
    // What is left says nothing: the empty-message failure the runtime raises
    // when every address of a multi-address host fails to connect, or a thrown
    // value that is not an error at all. Describe it, keeping the original as
    // the cause.
    throw new Error(describeError(err), { cause: err })
  } finally {
    agent.destroy().catch(() => {})
  }
}
