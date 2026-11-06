import type {
  HttpRequest,
  ExecutedRequestResult,
  ResolvedRequestSnapshot,
  ScriptResultsBundle,
  EnvironmentChanges,
  CookieSnapshot,
  WorkspaceHttpSettings,
  HeaderEntry,
  KeyValuePair,
  QueryDecodeWarning,
  ExecutionWarning
} from '@shared/types'
import { DEFAULT_ACCEPT_ENCODING, FALLBACK_USER_AGENT } from '@shared/types'
import { executePreRequest, executePostResponse } from '../scripting'
import { createValueMask, maskScriptResults } from '../scripting/mask-script-results'
import {
  applyAuth,
  authFieldTexts,
  mapAuthStrings,
  resolveAuthConfig,
  MASK_PRESERVING_MATERIALIZATION
} from './auth'
import { resolveRequestVariables, type ResolvedRequest } from './variables'
import {
  splitUrlAndParams,
  assembleQuery,
  encodeQueryComponentPreservingMasks
} from '@shared/lib/query-string'
import { resolveSettings } from './settings-resolver'
import { sendRequestWithRaw, type ProxyOption } from './client'
import { openCookieSession, type CookieRejection, type CookieSession } from './cookie-jar'
import { snapshotFromSetCookie } from './cookie-store'
import { encodeMultipart } from './multipart-encoder'
import { readBinary } from './binary-store'
import type { ResolvedTlsMaterial } from '../tls/resolve'
import type { SecretMasker } from '../secrets/markers'
import { CoreError } from '../shared/context'
import { describeError } from '../shared/describe-error'

/**
 * Host-provided context for a single request execution. The adapter (desktop
 * IPC handler or the future CLI command) resolves these and passes them in:
 *
 * - `workspaceSettings` — resolved workspace HTTP defaults (the desktop reads
 *   them from its per-session cache; the CLI loads them on demand).
 * - `resolveTls` — TLS material resolver bound to the active workspace/app
 *   scopes. Optional: when absent, requests go out with Node's default trust.
 * - `onCookiesCaptured` — invoked after Set-Cookie capture so the adapter can
 *   broadcast a change event. The cookie jar holds no active-workspace pointer:
 *   it is driven from the `workspacePath` + `environmentId` passed in here.
 *
 * Cancellation (`signal`) and the request timeout are owned by the adapter,
 * which registers the AbortController for `http:cancel` and clears the timer.
 */
export interface ExecuteOptions {
  environmentId: string | null
  workspaceSettings: WorkspaceHttpSettings
  /** A fixed proxy (desktop app settings) or a per-target resolver (CLI: flag / env / `NO_PROXY`). */
  proxy?: ProxyOption
  signal?: AbortSignal
  /**
   * The sending surface's default `User-Agent` (desktop `Fetchpier/<app>`, CLI
   * `Fetchpier-CLI/<cli>`), added when the request carries no enabled
   * `User-Agent` header. Defaults to the version-less fallback.
   */
  userAgent?: string
  /**
   * Names that are secrets in the environment. A value a script writes under one
   * of these names during this send is masked in the script output like any
   * resolved secret. The masker alone only knows the secrets the request
   * referenced before it ran.
   */
  secretNames?: Iterable<string>
  /**
   * Also return the response as received (`unmaskedResponse`) when masking changed
   * it. `response` stays masked either way — it is what logs and history read. Set
   * by the desktop when the user turned off "hide secrets in responses" and by the
   * CLI under `--show-secrets`.
   */
  revealResponse?: boolean
  /**
   * Adapter-bound TLS resolver. `onWarning` receives a plain-language reason when
   * configured material cannot be applied; it becomes a `TLS_MATERIAL_UNAVAILABLE`
   * advisory on the result.
   */
  resolveTls?: (
    url: string,
    environment: Record<string, string>,
    onWarning?: (reason: string) => void
  ) => Promise<ResolvedTlsMaterial | undefined>
  onCookiesCaptured?: (environmentId: string) => void
  /**
   * Raw buffer body for `bodyType === 'binary'` requests (REQ-0065). The
   * adapter resolves the workspace-relative ref and reads the file into a
   * buffer before calling `execute`. When present, the variable resolver and
   * form-field encoder are bypassed and the buffer is sent verbatim.
   */
  binaryBody?: Buffer
  /**
   * Workspace path for everything `execute` reads off disk itself: the
   * multipart encoder's staged file parts (REQ-0066) and the cookie jar
   * session, which holds no active-workspace pointer of its own. Required
   * when sending `bodyType === 'multipart-form'`, and — together with
   * `environmentId` — for the jar to run at all; without it the send goes out
   * with no cookies. Binary uploads do not need it: the adapter resolves the
   * ref and passes the buffer in `binaryBody`.
   */
  workspacePath?: string
  /**
   * REQ-0070: secret masking for this execution. When present, the adapter has
   * already seeded `request.variables` with this masker's `markerVariables`
   * (secret names → interpolation markers) and resolved the referenced secrets
   * to plaintext. `execute` then renders the markers twice: to plaintext at the
   * wire boundary, and to `{secret:<name>}` for the snapshot the activity log
   * and reporters consume. Absent for workspaces with no secrets — behavior is
   * then byte-identical to before.
   */
  secrets?: SecretMasker
}

/** Apply a string transform across every interpolatable field of a resolved request. */
function mapResolvedStrings(r: ResolvedRequest, fn: (s: string) => string): ResolvedRequest {
  return {
    method: r.method,
    url: fn(r.url),
    params: r.params?.map((p) => ({ ...p, key: fn(p.key), value: fn(p.value) })),
    headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [fn(k), fn(v)])),
    headerList: r.headerList?.map((h) => ({ name: fn(h.name), value: fn(h.value) })),
    body: r.body !== undefined ? fn(r.body) : undefined,
    formFields: r.formFields?.map((f) => ({ ...f, key: fn(f.key), value: fn(f.value) })),
    multipartParts: r.multipartParts?.map((p) => {
      const name = fn(p.name)
      const contentType = p.contentType !== undefined ? fn(p.contentType) : undefined
      if (p.kind === 'text') return { ...p, name, contentType, value: fn(p.value) }
      return {
        ...p,
        name,
        contentType,
        filename: p.filename !== undefined ? fn(p.filename) : undefined
      }
    }),
    unresolvedVariables: r.unresolvedVariables
  }
}

/** Build the wire body for a resolved request (form-encode when applicable). */
function buildBody(r: ResolvedRequest, hasBinary: boolean): string | undefined {
  let body = r.body
  if (!hasBinary && r.formFields && r.formFields.length > 0) {
    const enabled = r.formFields.filter((f) => f.enabled && f.key)
    if (enabled.length > 0) {
      body = enabled
        .map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`)
        .join('&')
    }
  }
  return body
}

/**
 * REQ-0115: turn a capture outcome into the send's non-fatal advisories. A
 * refused cookie is user-visible work that was dropped, so it is reported rather
 * than logged — the whole point of adding validation was to explain it.
 */
function toCookieWarnings(res: {
  rejected: readonly CookieRejection[]
  crossSiteInsecure: readonly { name: string; host: string }[]
}): ExecutionWarning[] {
  return [
    ...res.rejected.map((r): ExecutionWarning => ({
      code: 'COOKIE_REJECTED',
      name: r.name,
      host: r.host,
      reason: r.reason
    })),
    ...res.crossSiteInsecure.map((c): ExecutionWarning => ({
      code: 'COOKIE_CROSS_SITE_INSECURE',
      name: c.name,
      host: c.host
    }))
  ]
}

function hasHeaderNamed(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === lower)
}

/**
 * The implicit default request headers (User-Agent, Accept-Encoding): added only
 * when the request carries no enabled header of that name. Applied before the
 * wire/snapshot split so the snapshot, the activity log and every report show
 * what actually went out. Never written back into the request file.
 */
function implicitDefaultHeaders(
  headers: Record<string, string>,
  userAgent: string
): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  if (!hasHeaderNamed(headers, 'user-agent')) out.push({ name: 'User-Agent', value: userAgent })
  if (!hasHeaderNamed(headers, 'accept-encoding')) {
    out.push({ name: 'Accept-Encoding', value: DEFAULT_ACCEPT_ENCODING })
  }
  return out
}

function mergeEnvChanges(
  base: EnvironmentChanges | undefined,
  next: EnvironmentChanges | undefined
): EnvironmentChanges | undefined {
  if (!base && !next) return undefined
  const out: EnvironmentChanges = {
    set: { ...(base?.set ?? {}) },
    removed: [...(base?.removed ?? [])]
  }
  if (next) {
    for (const [k, v] of Object.entries(next.set)) {
      out.set[k] = v
      const idx = out.removed.indexOf(k)
      if (idx >= 0) out.removed.splice(idx, 1)
    }
    for (const k of next.removed) {
      delete out.set[k]
      if (!out.removed.includes(k)) out.removed.push(k)
    }
  }
  return out.removed.length === 0 && Object.keys(out.set).length === 0 ? undefined : out
}

/**
 * Run the full request pipeline: pre-request script → auth → variable
 * resolution → settings merge → cookie injection → TLS resolution → send →
 * Set-Cookie capture → post-response script. Returns the structured result the
 * renderer (or CLI) renders. Never throws for transport/script failures — those
 * surface in the returned `error` / `scriptResults` fields.
 */
export async function execute(
  request: HttpRequest,
  options: ExecuteOptions
): Promise<ExecutedRequestResult> {
  const {
    environmentId,
    workspaceSettings,
    proxy,
    signal,
    resolveTls,
    onCookiesCaptured,
    workspacePath,
    secrets
  } = options
  // Bytes an adapter supplied win; otherwise a binary body is read from the
  // workspace below, by the engine, for every surface (CLI hardening).
  let binaryBody = options.binaryBody
  const userAgent = options.userAgent ?? FALLBACK_USER_AGENT

  // A `# @binary-file:` reference the parser could not accept: sending the
  // request bodiless would silently drop the file its author attached.
  if (request.invalidBinaryRef !== undefined) {
    return {
      error: `invalid binary file reference: ${request.invalidBinaryRef}`,
      notSent: true
    }
  }

  // Advisories raised by the transport and the TLS resolver while the send is
  // prepared and read. Nothing on the send path writes to the process console.
  const transportWarnings: ExecutionWarning[] = []
  const pushTransportWarning = (w: ExecutionWarning): void => {
    transportWarnings.push(w)
  }

  // Script output and the response are masked inside the engine, once, for every
  // consumer (desktop console + activity log, CLI terminal, reports, history).
  // One value set for both: the secrets this send resolved plus whatever a script
  // wrote under a secret name — a login's post-response script that stores the
  // token it just received is the case the response must not miss.
  const secretNameSet = new Set<string>([
    ...(options.secretNames ?? []),
    ...(secrets ? Object.keys(secrets.scriptEnvironment) : [])
  ])
  const secretValueMask = (changes: EnvironmentChanges | undefined): ((s: string) => string) => {
    const values: Record<string, string> = { ...(secrets?.scriptEnvironment ?? {}) }
    for (const [name, value] of Object.entries(changes?.set ?? {})) {
      if (secretNameSet.has(name)) values[name] = value
    }
    return createValueMask(values)
  }
  const maskedScripts = (
    bundle: ScriptResultsBundle,
    changes: EnvironmentChanges | undefined
  ): ScriptResultsBundle | undefined => {
    if (!bundle.preRequest && !bundle.postResponse) return undefined
    return maskScriptResults(bundle, secretValueMask(changes))
  }

  const envIn: Record<string, string> = { ...(request.variables ?? {}) }
  // Scripts read secret variables as plaintext (HMAC signing etc., §6.4); the
  // interpolation map keeps them as markers. We expose plaintext to the sandbox
  // and force the markers back when building the interpolation variables.
  const scriptEnv: Record<string, string> = secrets
    ? { ...envIn, ...secrets.scriptEnvironment }
    : envIn
  const scriptResults: ScriptResultsBundle = {}
  let envChanges: EnvironmentChanges | undefined

  // Shared bag of temporary variables between pre and post scripts.
  let scriptVars: Record<string, unknown> = {}

  let liveRequest: HttpRequest = { ...request }

  // 1. Pre-request script
  if (request.preRequestScript && request.preRequestScript.trim()) {
    const pre = executePreRequest(request.preRequestScript, {
      request: liveRequest,
      environment: scriptEnv,
      variables: scriptVars
    })
    scriptResults.preRequest = pre.result
    scriptVars = pre.variables

    if (!pre.result.success) {
      envChanges = mergeEnvChanges(envChanges, pre.result.environmentChanges)
      return {
        scriptResults: maskedScripts(scriptResults, envChanges),
        environmentChanges: envChanges,
        error: `Pre-request script failed: ${pre.result.error?.message ?? 'unknown error'}`,
        notSent: true
      }
    }

    // Apply mutations to the request + variables. Multipart parts emitted
    // by the sandbox arrive as `modifiedRequest.multipartParts` and replace
    // the in-flight list wholesale (positional replace; see fp-sandbox.ts).
    // Re-apply secret markers over the (plaintext) script environment so
    // interpolation masks secrets regardless of what the script read.
    const preMultipartParts = pre.result.modifiedRequest?.multipartParts
    liveRequest = {
      ...liveRequest,
      method: pre.request.method,
      url: pre.request.url,
      headers: pre.request.headers,
      headerList: pre.request.headerList,
      body: pre.request.body,
      multipartParts:
        preMultipartParts !== undefined ? preMultipartParts : liveRequest.multipartParts,
      variables: secrets ? { ...pre.environment, ...secrets.markerVariables } : pre.environment
    }
    envChanges = mergeEnvChanges(envChanges, pre.result.environmentChanges)
  } else if (secrets) {
    // No pre-request script: still seed markers for interpolation.
    liveRequest = { ...liveRequest, variables: { ...envIn, ...secrets.markerVariables } }
  }

  // 2. Determine the structured query and the base URL (REQ-0081). The desktop
  // passes `params` and keeps `url` as the base; the CLI parser emits a flat URL,
  // so we split it (token-aware) only when no structured query was provided.
  let baseUrl = liveRequest.url
  let queryParams: KeyValuePair[] = liveRequest.params ?? []
  // REQ-0086: malformed percent-encoding in a query key/value is contained at the
  // split seam (the parameter is kept raw and reported), so a malformed key never
  // aborts the run. The desktop already split on load and passes structured
  // `params`; the CLI hands a flat URL, so it splits (and collects warnings) here.
  let queryWarnings: QueryDecodeWarning[] = []
  if (liveRequest.params === undefined) {
    const split = splitUrlAndParams(liveRequest.url)
    baseUrl = split.baseUrl
    queryParams = split.params
    queryWarnings = split.warnings
  }

  // Resolve {{variables}} — including, separately, the auth config's OWN fields
  // (REQ-0111). Auth must be resolved before it is materialized, because
  // materializing is lossy: Basic base64-encodes its pair and api-key-in-query
  // percent-encodes its value, and either step destroys a `{{reference}}` (or a
  // secret marker) as *characters* before it can be substituted. `liveRequest`
  // itself is not mutated, so the post-response script sees the same request
  // shape as today. With secrets, `resolved` carries markers; `wireResolved` has
  // plaintext for the wire, `logResolved` has the named masks for the snapshot.
  const variables = liveRequest.variables ?? {}
  const resolvedAuth = resolveAuthConfig(liveRequest.auth, variables)
  const resolvedBase = resolveRequestVariables(
    { ...liveRequest, url: baseUrl, params: queryParams },
    variables
  )
  // Auth's unresolved names join the request's own set, so an unknown reference
  // in a credential is reported like any other (it would otherwise vanish).
  const resolved: ResolvedRequest = {
    ...resolvedBase,
    unresolvedVariables: [
      ...resolvedBase.unresolvedVariables,
      ...resolvedAuth.unresolved.filter((n) => !resolvedBase.unresolvedVariables.includes(n))
    ]
  }
  const wireResolved = secrets ? mapResolvedStrings(resolved, secrets.wireRender) : resolved
  const logResolved = secrets ? mapResolvedStrings(resolved, secrets.logRender) : resolved

  // Warn-and-proceed: the references stay literal and the request still goes out.
  // Carried on the result so an adapter can show them — a log line is not a
  // channel a UI or a CI report can read (REQ-0111 follow-up).
  const unresolvedWarnings: ExecutionWarning[] = resolved.unresolvedVariables.map((name) => ({
    code: 'UNRESOLVED_VARIABLE',
    name
  }))
  // Materialize the credential once per render side. With secrets the resolved
  // auth fields carry markers, and base64 / percent-encoding would bury them, so
  // the credential is built AFTER each side is rendered: plaintext for the wire,
  // `{secret:<name>}` for the snapshot. Without secrets both renders are the
  // identity and the two calls produce the same result. api-key-in-query is
  // still appended to the BASE url here (§2.2 unchanged) so it never routes
  // through the structured assembly; the user params are assembled after. The
  // log side keeps its mask legible through the encoder, matching the URL rule.
  const wireWithAuthRaw = applyAuth(
    wireResolved,
    secrets ? mapAuthStrings(resolvedAuth.auth, secrets.wireRender) : resolvedAuth.auth
  )
  const logWithAuthRaw = applyAuth(
    logResolved,
    secrets ? mapAuthStrings(resolvedAuth.auth, secrets.logRender) : resolvedAuth.auth,
    secrets ? MASK_PRESERVING_MATERIALIZATION : {}
  )
  // Implicit defaults, decided once on the wire side and applied to both sides so
  // the snapshot reports exactly what was sent.
  // Binary body (REQ-0065, now engine-owned): read the staged file from the
  // workspace — where the multipart encoder already reads its parts — so the
  // desktop and the CLI send the same bytes. A missing file is refused before
  // anything goes out; it used to leave the command line sending an empty body.
  let binaryContentType: string | undefined
  if (
    binaryBody === undefined &&
    liveRequest.bodyType === 'binary' &&
    liveRequest.binaryFile?.ref
  ) {
    const file = liveRequest.binaryFile
    const refuse = (error: string): ExecutedRequestResult => ({
      scriptResults: maskedScripts(scriptResults, envChanges),
      environmentChanges: envChanges,
      error,
      notSent: true
    })
    if (!workspacePath) return refuse('Binary request requires a workspacePath to read the file.')
    try {
      binaryBody = await readBinary(workspacePath, file.ref)
    } catch (err) {
      return refuse(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `binary file not found: ${file.originalName || file.ref}`
          : describeError(err)
      )
    }
    if (!hasHeaderNamed(wireWithAuthRaw.headers, 'content-type')) {
      binaryContentType = file.mimeType || 'application/octet-stream'
    }
  }

  const defaults = [
    ...(binaryContentType ? [{ name: 'Content-Type', value: binaryContentType }] : []),
    ...implicitDefaultHeaders(wireWithAuthRaw.headers, userAgent)
  ]
  const withDefaults = <T extends { headers: Record<string, string>; headerList?: HeaderEntry[] }>(
    r: T
  ): T =>
    defaults.length === 0
      ? r
      : {
          ...r,
          headers: { ...r.headers, ...Object.fromEntries(defaults.map((d) => [d.name, d.value])) },
          ...(r.headerList ? { headerList: [...r.headerList, ...defaults] } : {})
        }
  const wireWithAuth = withDefaults(wireWithAuthRaw)
  const logWithAuth = withDefaults(logWithAuthRaw)

  // Resolve settings early — `encodeUrl` gates the query assembly. Then assemble
  // the final outgoing URL: resolved base (+ any api-key query) plus the resolved
  // structured params, contextually percent-encoded when `encodeUrl` is on, raw
  // (assembled by hand, no `new URL()`) when off. Wire vs log differ only with secrets.
  const resolvedSettings = resolveSettings(request.settings, workspaceSettings)
  const wireUrl = assembleQuery(
    wireWithAuth.url,
    wireWithAuth.params ?? [],
    resolvedSettings.encodeUrl
  )
  // The masked snapshot keeps `{secret:<name>}` masks legible (unencoded) while
  // still encoding the surrounding literal/plain segments — the wire above is
  // unaffected (it encodes the resolved plaintext).
  const logUrl = assembleQuery(
    logWithAuth.url,
    logWithAuth.params ?? [],
    resolvedSettings.encodeUrl,
    secrets ? encodeQueryComponentPreservingMasks : undefined
  )

  // Binary bodies bypass form-field encoding entirely (binary uploads are a
  // single-file raw body, not a multi-part composition). `finalBody` is what
  // goes on the wire (secrets resolved); `logBody` is the masked counterpart
  // for the snapshot. Identical when there are no secrets.
  const finalBody = buildBody(wireResolved, binaryBody !== undefined)
  const logBody = buildBody(logResolved, binaryBody !== undefined)

  // Multipart encoding (REQ-0066). Disabled parts are excluded by the
  // encoder. The encoder reads each file part's bytes from
  // `requests/.files/` and emits a single Buffer + the Content-Type header
  // (including the generated boundary).
  let multipartEncoded: { contentType: string; body: Buffer } | undefined
  if (
    binaryBody === undefined &&
    liveRequest.bodyType === 'multipart-form' &&
    wireResolved.multipartParts
  ) {
    if (!workspacePath) {
      return {
        scriptResults: maskedScripts(scriptResults, envChanges),
        environmentChanges: envChanges,
        error:
          'Multipart request requires a workspacePath in ExecuteOptions to read staged file parts.',
        notSent: true
      }
    }
    try {
      const encoded = await encodeMultipart(wireResolved.multipartParts, { workspacePath })
      multipartEncoded = { contentType: encoded.contentType, body: encoded.body }
    } catch (err) {
      return {
        scriptResults: maskedScripts(scriptResults, envChanges),
        environmentChanges: envChanges,
        error: describeError(err),
        notSent: true
      }
    }
  }

  // 3. Send (settings already resolved above for the URL assembly).
  // Cookie jar: inject Cookie header before sending unless disabled.
  const effectiveDisableCookieJar =
    request.disableCookieJar === true || resolvedSettings.disableCookieJar
  const finalHeaders: Record<string, string> = { ...wireWithAuth.headers }
  // The wire-bound ordered list (when the request carried one): authoritative
  // for what undici sends, preserving order + duplicates. The record above is
  // the lossy fallback for legacy/importer-built requests.
  const finalHeaderList: HeaderEntry[] | undefined = wireWithAuth.headerList
    ? [...wireWithAuth.headerList]
    : undefined
  let cookieHeaderValue: string | undefined
  let sentCookies: CookieSnapshot[] = []
  const hasExplicitCookie = Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'cookie')

  // REQ-0115: the jar is opened once for the whole send and drives every hop from
  // memory. The client owns the `Cookie` header from here on — it must be set per
  // hop, against that hop's host, which cannot be decided in advance. What is
  // still computed here is only the *display* value for the snapshot and the
  // activity log, so the reported request keeps showing what went out first.
  let cookieSession: CookieSession | undefined
  if (!effectiveDisableCookieJar && environmentId && workspacePath) {
    try {
      // A hand-written `Cookie` header decides what goes OUT — nothing more. The
      // response's cookies are still captured, because choosing what to send says
      // nothing about whether the session the server hands back is worth keeping,
      // and the workspace already has a dedicated switch for "stay out entirely"
      // (`disableCookieJar` and its per-request marker).
      cookieSession = await openCookieSession(workspacePath, environmentId, {
        attach: !hasExplicitCookie
      })
      const firstHop = cookieSession.headerFor(wireUrl)
      if (firstHop) {
        cookieHeaderValue = firstHop
        finalHeaders['Cookie'] = firstHop
        finalHeaderList?.push({ name: 'Cookie', value: firstHop })
      }
      // `headerFor` already recorded this hop in the session; the client will
      // recompute it for the real first dispatch, so drop the duplicate.
      cookieSession.sent.length = 0
    } catch (err) {
      // The send still goes out — without stored cookies, which is exactly what
      // the user needs to be told when the server then answers unauthenticated.
      pushTransportWarning({
        code: 'COOKIE_JAR_UNAVAILABLE',
        phase: 'read',
        reason: describeError(err)
      })
      cookieSession = undefined
    }
  }

  // TLS material is resolved per origin: up front for the first one, and by the
  // transport for every other origin a redirect reaches (security finding P1-2 —
  // a hop must never present the certificate chosen for another host). Each
  // resolution keeps the same contract, and one reason is reported once however
  // many hops hit it (an unreadable CA is read again for every origin).
  // TLS cert refs resolve against plaintext (a secret could name a cert path);
  // the result only reads a file, it is never logged.
  const tlsVariables = secrets ? { ...variables, ...secrets.scriptEnvironment } : variables
  const tlsReasons = new Set<string>()
  const warnTls = (reason: string): void => {
    if (tlsReasons.has(reason)) return
    tlsReasons.add(reason)
    pushTransportWarning({ code: 'TLS_MATERIAL_UNAVAILABLE', reason })
  }
  const resolveTlsFor = async (url: string): Promise<ResolvedTlsMaterial | undefined> => {
    if (!resolveTls) return undefined
    try {
      return await resolveTls(url, tlsVariables, warnTls)
    } catch (err) {
      // REQ-0089: a contractual secret failure resolving the client-cert
      // passphrase (locked / needs-value / corrupt) must surface before the
      // handshake, not be swallowed as an opaque TLS error — re-throw it.
      if (err instanceof CoreError && err.code.startsWith('SECRETS_')) throw err
      // Any other TLS resolution glitch (e.g. an unreadable cert file) never
      // blocks a send: advise and fall through with no extra material.
      warnTls(describeError(err))
      return undefined
    }
  }
  const tlsMaterial = await resolveTlsFor(wireUrl)
  const tlsForHop = (url: string): Promise<ResolvedTlsMaterial | undefined> =>
    url === wireUrl ? Promise.resolve(tlsMaterial) : resolveTlsFor(url)

  // The docblock above promises this function does not throw for transport
  // failures — it did, and both adapters had to grow their own catch. Honouring
  // it here is what keeps everything computed *before* the send: without this,
  // the advisories built above (unresolved references, malformed query keys)
  // were discarded precisely when a run failed, which is when they are most
  // worth reading. A contractual `CoreError` still propagates: a run that cannot
  // proceed is not a request that failed to reach its server.
  let rawSetCookie: string[]
  let response: Awaited<ReturnType<typeof sendRequestWithRaw>>['response']
  try {
    ;({ response, rawSetCookie } = await sendRequestWithRaw(
      {
        method: wireResolved.method,
        url: wireUrl,
        headers: finalHeaders,
        headerList: finalHeaderList,
        body:
          multipartEncoded !== undefined
            ? undefined
            : binaryBody !== undefined
              ? undefined
              : finalBody
      },
      {
        signal,
        proxy,
        userAgent,
        onWarning: pushTransportWarning,
        settings: resolvedSettings,
        tls: resolveTls ? tlsForHop : undefined,
        binaryBody,
        multipartBody: multipartEncoded,
        // REQ-0115: from here the client owns the `Cookie` header, per hop. The
        // one set above on `finalHeaders` is what the snapshot reports; the
        // interceptor recomputes it for the wire against each hop's host.
        cookies: cookieSession
      }
    ))
  } catch (err) {
    if (err instanceof CoreError) throw err
    // REQ-0115: a chain can hand over its session on an early hop and then fail
    // on a later one. Those cookies were legitimately received, so they are
    // persisted and reported even though the send as a whole failed — dropping
    // them would make a retry mysteriously unauthenticated.
    let failedCookieWarnings: ExecutionWarning[] = []
    let failedCookies: ExecutedRequestResult['cookies']
    if (cookieSession) {
      try {
        if (await cookieSession.flush()) onCookiesCaptured?.(environmentId!)
        failedCookieWarnings = toCookieWarnings(cookieSession)
        // Reported as well as persisted: telling the user a cookie was refused
        // while hiding the ones that were accepted on the same chain would be a
        // half-truth, and this is exactly the send they are trying to explain.
        failedCookies = { sent: cookieSession.sent, received: cookieSession.offered }
      } catch (flushErr) {
        pushTransportWarning({
          code: 'COOKIE_JAR_UNAVAILABLE',
          phase: 'persist',
          reason: describeError(flushErr)
        })
      }
    }
    const failedWarnings = [
      ...queryWarnings,
      ...unresolvedWarnings,
      ...failedCookieWarnings,
      ...transportWarnings
    ]
    const failedScripts = maskedScripts(scriptResults, envChanges)
    return {
      // Never `err.message`: the failure raised when every address of a
      // multi-address host is refused leaves its own message empty, and an
      // empty reason is indistinguishable from "no error" for every consumer.
      error: describeError(err),
      resolvedSettings,
      // A pre-request script already ran: its output and its environment writes
      // are part of the run whatever happened on the wire afterwards.
      ...(failedScripts ? { scriptResults: failedScripts } : {}),
      ...(envChanges ? { environmentChanges: envChanges } : {}),
      ...(failedCookies ? { cookies: failedCookies } : {}),
      ...(failedWarnings.length > 0 ? { warnings: failedWarnings } : {})
    }
  }

  // REQ-0115: every hop already captured into the session as it responded — the
  // transport discards a 3xx body but its headers travelled the handler chain, so
  // a login that hands its session over on a redirect is finally recorded. All
  // that is left is to persist and report.
  let receivedCookies: CookieSnapshot[] = []
  let cookieWarnings: ExecutionWarning[] = []
  if (cookieSession) {
    try {
      const wrote = await cookieSession.flush()
      receivedCookies = cookieSession.offered
      sentCookies = cookieSession.sent
      cookieWarnings = toCookieWarnings(cookieSession)
      if (wrote) onCookiesCaptured?.(environmentId!)
    } catch (err) {
      pushTransportWarning({
        code: 'COOKIE_JAR_UNAVAILABLE',
        phase: 'persist',
        reason: describeError(err)
      })
    }
  } else if (rawSetCookie.length > 0) {
    // The jar did not run for this send — no environment selected, the request
    // set its own `Cookie` header, or the jar is disabled. The response still
    // sent these, and hiding them because *we* chose not to store them would be
    // the tool withholding what it plainly observed. `stored` stays undefined:
    // nothing decided either way.
    const receivedAt = new Date()
    receivedCookies = rawSetCookie
      .map((h) => snapshotFromSetCookie(h, wireUrl, receivedAt))
      .filter((c): c is CookieSnapshot => c !== null)
  }

  // 4. Post-response script — sees the UNMASKED response so it can legitimately
  // extract values (e.g. capture an auth token). Secret masking is applied to
  // the returned response afterwards.
  if (request.postResponseScript && request.postResponseScript.trim()) {
    const post = executePostResponse(request.postResponseScript, {
      request: liveRequest,
      response,
      environment: scriptEnv,
      variables: scriptVars
    })
    scriptResults.postResponse = post.result
    envChanges = mergeEnvChanges(envChanges, post.result.environmentChanges)
  }

  const cookiesSummary =
    sentCookies.length > 0 || receivedCookies.length > 0
      ? { sent: sentCookies, received: receivedCookies }
      : undefined

  // Snapshot of the request as it went on the wire — but built from the masked
  // (`logResolved`) fields so secret values never reach the activity panel,
  // reporters, or `.runs/`. The multipart parts summary is the only place they
  // can see the encoded structure (file bytes are intentionally absent).
  const headersForSnapshot: Record<string, string> = { ...logWithAuth.headers }
  if (cookieHeaderValue !== undefined) headersForSnapshot['Cookie'] = cookieHeaderValue
  if (multipartEncoded) headersForSnapshot['Content-Type'] = multipartEncoded.contentType

  // Collect from the marker-bearing `resolved` fields (markers are gone in
  // `logResolved`, already replaced by `{secret:<name>}`). The auth config is
  // scanned separately: its markers live on `resolvedAuth`, not on `resolved`,
  // because the credential is materialized after the render split.
  const secretsMasked = secrets
    ? secrets.collectMaskedNames([
        ...authFieldTexts(resolvedAuth.auth),
        resolved.url,
        ...(resolved.params?.flatMap((p) => [p.key, p.value]) ?? []),
        ...(resolved.headerList
          ? resolved.headerList.flatMap((h) => [h.name, h.value])
          : [...Object.keys(resolved.headers), ...Object.values(resolved.headers)]),
        resolved.body,
        ...(resolved.formFields?.flatMap((f) => [f.key, f.value]) ?? []),
        ...(resolved.multipartParts?.flatMap((p) => [
          p.name,
          p.contentType,
          p.kind === 'text' ? p.value : p.filename
        ]) ?? [])
      ])
    : []

  const snapshot: ResolvedRequestSnapshot = {
    method: logResolved.method,
    url: logUrl,
    headers: headersForSnapshot,
    body: multipartEncoded !== undefined || binaryBody !== undefined ? undefined : logBody,
    multipartParts:
      multipartEncoded && logResolved.multipartParts
        ? logResolved.multipartParts
            .filter((p) => !p.disabled)
            .map((p) => {
              if (p.kind === 'text') {
                return {
                  kind: 'text' as const,
                  name: p.name,
                  disabled: false,
                  contentType: p.contentType,
                  value: p.value
                }
              }
              return {
                kind: 'file' as const,
                name: p.name,
                disabled: false,
                contentType: p.contentType,
                fileRef: p.file.ref,
                filename: p.filename ?? p.file.originalName,
                sizeBytes: p.file.sizeBytes
              }
            })
        : undefined,
    ...(secretsMasked.length > 0 ? { secretsMasked } : {})
  }

  // Best-effort response masking: a server may echo a secret back, or hand out
  // one a script then stores under a secret name. No marker exists there, so mask
  // by substring against the same values as the script output. `response` is
  // always the masked one — what every log and report reads; the copy as
  // received travels only when the adapter asked for it and it differs.
  const responseMask = secretValueMask(envChanges)
  const maskedBody = responseMask(response.body)
  const maskedHeaders = Object.fromEntries(
    Object.entries(response.headers).map(([k, v]) => [k, responseMask(v)])
  )
  const responseChanged =
    maskedBody !== response.body ||
    Object.entries(maskedHeaders).some(([k, v]) => v !== response.headers[k])
  const maskedResponse = responseChanged
    ? { ...response, body: maskedBody, headers: maskedHeaders }
    : response

  return {
    response: maskedResponse,
    ...(options.revealResponse && responseChanged ? { unmaskedResponse: response } : {}),
    scriptResults: maskedScripts(scriptResults, envChanges),
    environmentChanges: envChanges,
    resolvedSettings,
    cookies: cookiesSummary,
    request: snapshot,
    // REQ-0068 §4 Supuestos: optional remote-server IP. Today undici doesn't
    // surface the socket address from `Agent#request`; capturing it via a
    // custom `connect` hook is a follow-up. The activity-log serializer omits
    // the `# @remote-ip` directive when this is undefined — graceful
    // degradation, not a feature gate.
    remoteIp: undefined,
    // Non-fatal advisories. Query-decode warnings arise only on the flat-URL
    // (CLI) path — desktop sends pass structured params already validated at
    // load — while unresolved references can arise on either.
    // REQ-0115: cookie advisories ride the same channel. Ordered last so the
    // pre-existing kinds keep their position for consumers that read positionally.
    // CLI readiness: transport/TLS/decoding advisories come after them, for the
    // same reason.
    ...(queryWarnings.length +
      unresolvedWarnings.length +
      cookieWarnings.length +
      transportWarnings.length >
    0
      ? {
          warnings: [
            ...queryWarnings,
            ...unresolvedWarnings,
            ...cookieWarnings,
            ...transportWarnings
          ]
        }
      : {})
  }
}
