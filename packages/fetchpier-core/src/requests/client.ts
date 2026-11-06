import { Agent, ProxyAgent, Dispatcher, interceptors, errors as undiciErrors } from 'undici'
import { Readable } from 'node:stream'
import type {
  ExecutionWarning,
  HttpRequest,
  HttpResponse,
  ProxyConfig,
  WorkspaceHttpSettings
} from '@shared/types'
import { FALLBACK_USER_AGENT } from '@shared/types'
import { hasHeader, headersToUndiciArray, removeHeaders } from '@shared/lib/headers'
import type { CookieHopHooks } from './cookie-jar'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { CoreError } from '../shared/context'
import { describeError } from '../shared/describe-error'
import { decodeBody } from './decode-body'

/** Name of the abort reason an adapter's request timer uses (see {@link timeoutAbortReason}). */
export const TIMEOUT_ABORT_NAME = 'TimeoutError'

/** `30 s`, `1.5 s`, `200 ms` — how a timeout limit reads in a failure reason. */
export function formatTimeoutLimit(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  return `${Number.isInteger(s) ? s : Number(s.toFixed(1))} s`
}

/**
 * The value an adapter passes to `AbortController.abort()` when its request
 * timer fires. The client turns an abort carrying it into the failure reason
 * `timed out after <limit>`, so a timeout is never reported as a cancellation.
 */
export function timeoutAbortReason(ms: number): Error {
  const err = new Error(`timed out after ${formatTimeoutLimit(ms)}`)
  err.name = TIMEOUT_ABORT_NAME
  return err
}

/** A proxy for the whole send, or a per-target resolver (`NO_PROXY`, per-scheme proxies). */
export type ProxyOption = ProxyConfig | ((url: string) => ProxyConfig | undefined)

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

/**
 * TLS material for the send, or a resolver the client asks once per origin a
 * redirect chain reaches (symmetric to {@link ProxyOption}). Fixed material keeps
 * its meaning for the first origin only: on any other origin just its CAs apply,
 * because a client certificate identifies the client to the host it was chosen
 * for.
 */
export type TlsOption =
  ResolvedTlsMaterial | ((url: string) => Promise<ResolvedTlsMaterial | undefined>)

export interface SendOptions {
  /** AbortController signal for cancellation. */
  signal?: AbortSignal
  /**
   * Optional proxy: a fixed configuration (used only if `enabled` and `url` are
   * set), or a resolver asked for the target URL.
   */
  proxy?: ProxyOption
  /** `User-Agent` to add when the request carries none. Defaults to {@link FALLBACK_USER_AGENT}. */
  userAgent?: string
  /**
   * Non-fatal advisories raised while preparing or reading the send (an HTTP/2
   * downgrade, a replaced Content-Type, a body that could not be decoded). The
   * client never writes to the process console.
   */
  onWarning?: (warning: ExecutionWarning) => void
  /** Fully resolved transport settings — applied to the dispatcher and request. */
  settings?: WorkspaceHttpSettings
  /**
   * Optional TLS material (additional CAs and/or client certificate): fixed for
   * the send, or resolved per origin — see {@link TlsOption}.
   */
  tls?: TlsOption
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

type Interceptor = (dispatch: Dispatcher['dispatch']) => Dispatcher['dispatch']

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

/**
 * Security finding P1-2 — the dispatcher is chosen **per hop**.
 *
 * Innermost entry of the chain, so the transport reaches it once per hop, after
 * the redirect handler has rewritten the hop's origin (the same ordering the
 * cookie interceptor relies on). A hop to the send's first origin goes to the
 * base dispatcher; a hop to any other origin goes to the dispatcher built for
 * that origin, which carries that origin's own proxy decision and TLS material.
 *
 * Building one may need to read certificate files, so the hop is handed over
 * once that settles; a failure is reported to the handler the way undici's own
 * DNS interceptor reports a failed lookup. An abort that arrives meanwhile is
 * honoured by the dispatcher as soon as it starts the hop.
 */
function hopRouter(
  firstOrigin: string,
  dispatcherFor: (origin: string, url: string) => Promise<Dispatcher>
): Interceptor {
  return (dispatch) => (opts, handler) => {
    const url = hopUrl(opts)
    const origin = url ? new URL(url).origin : null
    if (!url || !origin || origin === firstOrigin) return dispatch(opts, handler)
    dispatcherFor(origin, url)
      .then((dispatcher) => dispatcher.dispatch(opts, handler))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(describeError(err))
        handler.onResponseError?.(null as unknown as Dispatcher.DispatchController, error)
      })
    return true
  }
}

/** Whether a dispatch's headers (record or positional array) carry `name`. */
function hasDispatchHeader(headers: Dispatcher.DispatchOptions['headers'], name: string): boolean {
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return true
    }
    return false
  }
  if (headers && typeof headers === 'object') {
    return Object.keys(headers).some((k) => k.toLowerCase() === name)
  }
  return false
}

/**
 * `followAuthorizationOnRedirect: true` — put the request's `Authorization` back
 * on a hop that arrives without it.
 *
 * The transport strips `Authorization` whenever a redirect changes origin
 * (`redirect-handler.js#shouldRemoveHeader`, not configurable), so the setting had
 * no effect across origins. Composed inside the redirect interceptor, like the
 * cookie one, this re-adds it per hop. Only `Authorization`, as in Postman's
 * "Follow Authorization header".
 */
function followAuthorizationInterceptor(values: string[]): Interceptor {
  return (dispatch) => (opts, handler) => {
    if (values.length === 0 || hasDispatchHeader(opts.headers, 'authorization')) {
      return dispatch(opts, handler)
    }
    const headers = opts.headers
    if (Array.isArray(headers)) {
      const restored: string[] = [...(headers as string[])]
      for (const v of values) restored.push('Authorization', v)
      return dispatch({ ...opts, headers: restored }, handler)
    }
    const record: Record<string, string | string[] | undefined> =
      headers && typeof headers === 'object'
        ? { ...(headers as Record<string, string | string[] | undefined>) }
        : {}
    record.Authorization = values.length === 1 ? values[0] : values
    return dispatch({ ...opts, headers: record }, handler)
  }
}

/** Every `Authorization` value of an outgoing header set, in order. */
function authorizationValues(headers: Record<string, string> | string[]): string[] {
  if (Array.isArray(headers)) {
    const found: string[] = []
    for (let i = 0; i < headers.length; i += 2) {
      if (headers[i].toLowerCase() === 'authorization') found.push(headers[i + 1])
    }
    return found
  }
  return Object.entries(headers)
    .filter(([k]) => k.toLowerCase() === 'authorization')
    .map(([, v]) => v)
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

/**
 * The dispatcher that talks to one origin: a direct `Agent`, or a `ProxyAgent`
 * when the proxy that applies to that origin is enabled. The first origin of a
 * send gets one built before the send; every other origin a redirect reaches
 * gets its own (see {@link hopRouter}), so no origin inherits another's client
 * certificate or proxy decision.
 */
function buildBaseDispatcher(
  settings: WorkspaceHttpSettings,
  isHttps: boolean,
  proxy?: ProxyConfig,
  tlsMaterial?: ResolvedTlsMaterial,
  onWarning?: (warning: ExecutionWarning) => void
): Dispatcher {
  // HTTP/2 is only meaningful over HTTPS. Advise and fall back to HTTP/1.1 for plain HTTP.
  let allowH2: boolean
  if (settings.httpVersion === 'http2') {
    if (!isHttps) {
      onWarning?.({ code: 'HTTP2_DOWNGRADED' })
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
  const trust: Record<string, unknown> = { rejectUnauthorized: settings.verifySsl }
  if (tlsMaterial?.ca && tlsMaterial.ca.length > 0) trust.ca = tlsMaterial.ca
  const tlsOptions: Record<string, unknown> = { ...trust }
  if (tlsMaterial?.cert) tlsOptions.cert = tlsMaterial.cert
  if (tlsMaterial?.key) tlsOptions.key = tlsMaterial.key
  if (tlsMaterial?.pfx) tlsOptions.pfx = tlsMaterial.pfx
  if (tlsMaterial?.passphrase) tlsOptions.passphrase = tlsMaterial.passphrase

  return proxy && proxy.enabled && proxy.url.trim()
    ? new ProxyAgent({
        uri: proxy.url.trim(),
        token:
          proxy.username.trim() || proxy.password
            ? 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
            : undefined,
        requestTls: tlsOptions,
        // The proxy gets the trust material only: the client certificate
        // identifies the client to the target server, and the proxy is not it.
        proxyTls: trust
      })
    : new Agent({ allowH2, connect: tlsOptions })
}

interface ChainParts {
  settings: WorkspaceHttpSettings
  cookies?: CookieHopHooks
  /** Routes a hop to another origin to that origin's dispatcher (redirects only). */
  router?: Interceptor
  /** The request's `Authorization` values, restored per hop when the setting asks. */
  authorization: string[]
}

function composeChain(base: Dispatcher, parts: ChainParts): Dispatcher {
  const { settings, cookies, router, authorization } = parts
  const maxRedirections = settings.followRedirects ? settings.maxRedirects : 0

  // Order matters. `compose` applies left to right, and each interceptor wraps the
  // previous one — so the LAST entry is the outermost and runs first. The redirect
  // interceptor must be outermost (it drives the loop and strips by origin); the
  // per-hop ones must be inside it, where they are re-entered once per hop. The
  // router is innermost because it replaces the base dispatch for other origins.
  const chain: Interceptor[] = []
  if (maxRedirections > 0 && router) chain.push(router)
  if (maxRedirections > 0 && settings.followAuthorizationOnRedirect) {
    chain.push(followAuthorizationInterceptor(authorization))
  }
  if (cookies) chain.push(cookieInterceptor(cookies))
  if (maxRedirections > 0) chain.push(interceptors.redirect({ maxRedirections }))
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
  const { signal, settings = DEFAULT_WORKSPACE_HTTP_SETTINGS, onWarning } = options
  const userAgent = options.userAgent ?? FALLBACK_USER_AGENT

  const target = buildRequestTarget(httpRequest.url)
  const isHttps = target.protocol === 'https:'
  const proxy = typeof options.proxy === 'function' ? options.proxy(httpRequest.url) : options.proxy
  const tls = typeof options.tls === 'function' ? await options.tls(httpRequest.url) : options.tls
  const base = buildBaseDispatcher(settings, isHttps, proxy, tls, onWarning)

  // Every other origin a redirect reaches gets its own dispatcher, decided from
  // that hop's URL: its proxy and its TLS material, never the first origin's.
  const others = new Map<string, Promise<Dispatcher>>()
  const dispatcherFor = (origin: string, url: string): Promise<Dispatcher> => {
    let pending = others.get(origin)
    if (!pending) {
      pending = (async () => {
        const hopProxy = typeof options.proxy === 'function' ? options.proxy(url) : options.proxy
        const hopTls =
          typeof options.tls === 'function'
            ? await options.tls(url)
            : options.tls?.ca
              ? { ca: options.tls.ca }
              : undefined
        return buildBaseDispatcher(settings, new URL(url).protocol === 'https:', hopProxy, hopTls)
      })()
      others.set(origin, pending)
    }
    return pending
  }

  const start = performance.now()

  // When the request carries the ordered `headerList`, send undici the
  // positional array form (`[name, value, …]`) so order **and** duplicate names
  // survive on the wire — the object form would collapse same-name entries.
  // Otherwise fall back to the lossy record (legacy / importer-built requests).
  let headers: Record<string, string> | string[]
  if (httpRequest.headerList) {
    let list = [...httpRequest.headerList]
    if (!hasHeader(list, 'user-agent')) {
      list.push({ name: 'User-Agent', value: userAgent })
    }
    if (options.multipartBody) {
      // Encoder-generated Content-Type wins; warn + replace a manual one
      // (REQ §5.2 rule 9, REQ §7.2). The encoder owns the boundary header.
      if (hasHeader(list, 'content-type')) {
        onWarning?.({ code: 'CONTENT_TYPE_REPLACED' })
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
      : { ...httpRequest.headers, 'User-Agent': userAgent }

    if (options.multipartBody) {
      // Find any existing Content-Type variant in the headers map and replace
      // its value with ours — preserving the original key casing for the rest.
      const existingKey = Object.keys(record).find((k) => k.toLowerCase() === 'content-type')
      if (existingKey) {
        onWarning?.({ code: 'CONTENT_TYPE_REPLACED' })
        record = { ...record, [existingKey]: options.multipartBody.contentType }
      } else {
        record = { ...record, 'Content-Type': options.multipartBody.contentType }
      }
    }
    headers = record
  }

  const agent = composeChain(base, {
    settings,
    cookies: options.cookies,
    router: hopRouter(target.origin, dispatcherFor),
    authorization: authorizationValues(headers)
  })

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

    // Read the bytes exactly as they arrived and decode them against
    // `Content-Encoding` here, so every consumer sees one decoded body and one
    // status. A body that cannot be decoded is kept as received.
    const wire = Buffer.from(await response.body.arrayBuffer())
    const timingMs = performance.now() - start
    const encodingHeader = response.headers['content-encoding']
    const decoded = decodeBody(
      wire,
      Array.isArray(encodingHeader) ? encodingHeader.join(', ') : encodingHeader
    )
    if (decoded.warning) onWarning?.(decoded.warning)
    const responseBody = decoded.body.toString('utf-8')
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
        sizeBytes,
        compressedBytes: decoded.compressedBytes,
        decompressedBytes: decoded.decompressedBytes,
        decodingStatus: decoded.status
      },
      rawSetCookie
    }
  } catch (err) {
    // The adapter's request timer aborts with a recognizable reason: report the
    // limit that expired, not a cancellation the user never asked for.
    const reason: unknown = signal?.aborted ? signal.reason : undefined
    if (reason instanceof Error && reason.name === TIMEOUT_ABORT_NAME) {
      throw new Error(reason.message, { cause: err })
    }
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
    for (const pending of others.values()) {
      pending.then((d) => d.destroy()).catch(() => {})
    }
  }
}
