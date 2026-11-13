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
  setRecordHeaderUnique,
  MASK_PRESERVING_MATERIALIZATION
} from './auth'
import { resolveRequestVariables, type ResolvedRequest } from './variables'
import {
  splitUrlAndParams,
  splitUrlFragment,
  splitFormBody,
  assembleQuery,
  encodeQueryComponentPreservingMasks,
  encodeTemplateComponent
} from '@shared/lib/query-string'
import { resolveSettings } from './settings-resolver'
import {
  normalizeProtocol,
  sendRequestWithRaw,
  type ExchangeFacts,
  type ProxyOption
} from './client'
import { evaluateFindings } from '../findings/evaluate'
import { resolveFindingsSettings } from '@shared/lib/findings'
import { openCookieSession, type CookieRejection, type CookieSession } from './cookie-jar'
import { snapshotFromSetCookie } from './cookie-store'
import { encodeMultipart } from './multipart-encoder'
import { readBinary } from './binary-store'
import type { ResolvedTlsMaterial } from '../tls/resolve'
import { secretLogMask, type SecretMasker } from '../secrets/markers'
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
  /**
   * Passive security findings: evaluate the exchange this send performed
   * (`ExecutedRequestResult.findings`). The adapter decides *when* — the desktop
   * when the workspace's `http.findings.enabled` holds, the command line under
   * `--findings`; *what* is evaluated (disabled rules, expiry window) always comes
   * from the resolved workspace settings. Never adds network activity.
   */
  evaluateFindings?: boolean
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

/**
 * Build the wire body for a resolved request (form-encode when applicable).
 * `encode` is the component encoder; the masked snapshot passes the one that
 * keeps `{secret:<name>}` legible, as the URL assembly does.
 */
function buildBody(
  r: ResolvedRequest,
  hasBinary: boolean,
  encode: (component: string) => string = encodeURIComponent
): string | undefined {
  let body = r.body
  if (!hasBinary && r.formFields && r.formFields.length > 0) {
    const enabled = r.formFields.filter((f) => f.enabled && f.key)
    if (enabled.length > 0) {
      body = enabled.map((f) => `${encode(f.key)}=${encode(f.value)}`).join('&')
    }
  }
  return body
}

/** Binary and multipart bodies never take the form path. */
function isStructuredBody(r: HttpRequest): boolean {
  return r.bodyType === 'binary' || r.bodyType === 'multipart-form'
}

/** True when the request's (enabled) `Content-Type` is form-urlencoded. */
function hasFormContentType(r: HttpRequest): boolean {
  const headers =
    r.headerList ?? Object.entries(r.headers).map(([name, value]) => ({ name, value }))
  const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
  return contentType.toLowerCase().includes('application/x-www-form-urlencoded')
}

/**
 * The form body a pre-request script reads when the request carries structured
 * `formFields` (the desktop shape): the enabled fields, literal segments encoded
 * and `{{tokens}}` verbatim — the text the `.http` file stores.
 */
function formBodyTemplate(fields: KeyValuePair[]): string {
  return fields
    .filter((f) => f.enabled && f.key)
    .map((f) => `${encodeTemplateComponent(f.key)}=${encodeTemplateComponent(f.value)}`)
    .join('&')
}

/**
 * The URL a script reads (`fp.request.url`): the base plus the enabled structured
 * params (the desktop shape), literal segments encoded and `{{tokens}}` verbatim
 * — the URL the `.http` file stores, which the CLI shape already carries flat.
 */
function scriptUrl(request: HttpRequest): string {
  if (request.params === undefined) return request.url
  return assembleQuery(request.url, request.params, true, encodeTemplateComponent)
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
  // The values are the ones the masker was built with: a secret a pre-request
  // script removed keeps its old plaintext under the mask.
  const secretValues = (changes: EnvironmentChanges | undefined): Record<string, string> => {
    const values: Record<string, string> = { ...(secrets?.scriptEnvironment ?? {}) }
    for (const [name, value] of Object.entries(changes?.set ?? {})) {
      if (secretNameSet.has(name)) values[name] = value
    }
    return values
  }
  const secretValueMask = (changes: EnvironmentChanges | undefined): ((s: string) => string) =>
    createValueMask(secretValues(changes))
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
  // The masker the rest of the send renders with: `secrets`, with whatever the
  // pre-request script wrote to a referenced secret applied (set → new plaintext
  // on the wire, removed → no marker, so the reference is unresolved).
  let activeSecrets = secrets

  // 1. Pre-request script
  if (request.preRequestScript && request.preRequestScript.trim()) {
    // A structured form body (the desktop shape) reaches the script as its
    // encoded template, so `fp.request.body` reads what the CLI shape reads.
    const formTemplate =
      liveRequest.formFields?.length && !isStructuredBody(liveRequest)
        ? formBodyTemplate(liveRequest.formFields)
        : undefined
    // Likewise the URL: the desktop's base + structured params reach the script
    // as the full template URL the CLI shape reads.
    const urlTemplate = scriptUrl(liveRequest)
    const pre = executePreRequest(request.preRequestScript, {
      request: {
        ...liveRequest,
        url: urlTemplate,
        ...(formTemplate !== undefined ? { body: formTemplate } : {})
      },
      environment: scriptEnv,
      variables: scriptVars
    })
    scriptResults.preRequest = pre.result
    scriptVars = pre.variables

    if (!pre.result.success) {
      envChanges = mergeEnvChanges(envChanges, pre.result.environmentChanges)
      // The top-level error is printed and reported too: build it from the
      // masked bundle, never from the raw sandbox message.
      const failedScripts = maskedScripts(scriptResults, envChanges)
      return {
        scriptResults: failedScripts,
        environmentChanges: envChanges,
        error: `Pre-request script failed: ${failedScripts?.preRequest?.error?.message ?? 'unknown error'}`,
        notSent: true
      }
    }

    // Apply mutations to the request + variables. Multipart parts emitted
    // by the sandbox arrive as `modifiedRequest.multipartParts` and replace
    // the in-flight list wholesale (positional replace; see fp-sandbox.ts).
    // Re-apply secret markers over the (plaintext) script environment so
    // interpolation masks secrets regardless of what the script read. A write
    // to a referenced secret is used on this send, as a plain variable's is.
    if (secrets && pre.result.environmentChanges) {
      activeSecrets = secrets.withOverrides(
        pre.result.environmentChanges.set,
        pre.result.environmentChanges.removed
      )
    }
    const preMultipartParts = pre.result.modifiedRequest?.multipartParts
    // An untouched form template keeps the fields; a body the script changed
    // replaces them and goes out through the raw-form path below.
    const keepFormFields = formTemplate === undefined || pre.request.body === formTemplate
    // An untouched URL keeps the structured params; one the script changed
    // replaces them and is split again below, as the CLI shape is.
    const keepUrl = pre.request.url === urlTemplate
    liveRequest = {
      ...liveRequest,
      method: pre.request.method,
      url: keepUrl ? liveRequest.url : pre.request.url,
      params: keepUrl ? liveRequest.params : undefined,
      headers: pre.request.headers,
      headerList: pre.request.headerList,
      body: keepFormFields && formTemplate !== undefined ? liveRequest.body : pre.request.body,
      formFields: keepFormFields ? liveRequest.formFields : undefined,
      multipartParts:
        preMultipartParts !== undefined ? preMultipartParts : liveRequest.multipartParts,
      variables: activeSecrets
        ? { ...pre.environment, ...activeSecrets.markerVariables }
        : pre.environment
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
  // A fragment rides on the base (the split keeps it there for the file) but is
  // never sent (FMT-01, RFC 9112 §3.2): drop it before auth or the query is
  // appended, so an api-key query cannot land inside it and the snapshot is the
  // URL actually sent.
  baseUrl = splitUrlFragment(baseUrl).url
  // The same for a form body: the desktop passes structured `formFields`; the CLI
  // parser (or a script that rewrote the body) hands a raw form-urlencoded body,
  // so it is split with the loader's decoder and then built like the fields are.
  let formFields = liveRequest.formFields
  if (
    !formFields?.length &&
    liveRequest.body !== undefined &&
    !isStructuredBody(liveRequest) &&
    hasFormContentType(liveRequest)
  ) {
    formFields = splitFormBody(liveRequest.body)
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
    { ...liveRequest, url: baseUrl, params: queryParams, formFields },
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
  const wireResolved = activeSecrets
    ? mapResolvedStrings(resolved, activeSecrets.wireRender)
    : resolved
  // The log side also gets the value mask: a secret a pre-request script copied
  // verbatim (or wrote under a secret name and then used) carries no marker. It
  // runs before the URL and the credential are encoded, so an encoded copy is
  // caught too. `valueMaskedNames` joins the snapshot's `secretsMasked`.
  const requestValues = secretValues(envChanges)
  const requestValueMask = createValueMask(requestValues)
  const valueMaskedNames = new Set<string>()
  const countOf = (text: string, part: string): number => text.split(part).length - 1
  const logText = (text: string): string => {
    const rendered = activeSecrets ? activeSecrets.logRender(text) : text
    const masked = requestValueMask(rendered)
    if (masked !== rendered) {
      for (const name of Object.keys(requestValues)) {
        const mask = secretLogMask(name)
        if (countOf(masked, mask) > countOf(rendered, mask)) valueMaskedNames.add(name)
      }
    }
    return masked
  }
  const maskLog =
    activeSecrets !== undefined || Object.values(requestValues).some((v) => v.length > 0)
  const logResolved = maskLog ? mapResolvedStrings(resolved, logText) : resolved

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
    activeSecrets ? mapAuthStrings(resolvedAuth.auth, activeSecrets.wireRender) : resolvedAuth.auth
  )
  const logWithAuthRaw = applyAuth(
    logResolved,
    maskLog ? mapAuthStrings(resolvedAuth.auth, logText) : resolvedAuth.auth,
    maskLog ? MASK_PRESERVING_MATERIALIZATION : {}
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
  const assembledWireUrl = assembleQuery(
    wireWithAuth.url,
    wireWithAuth.params ?? [],
    resolvedSettings.encodeUrl
  )
  // The client sends a scheme-less URL over https: normalize it once here, so TLS
  // resolution, proxy routing, the cookie lookup and the snapshot all see the URL
  // actually used. The scheme is decided on the wire side; the log side follows
  // it (a masked `{secret:…}` base must not be judged scheme-less on its own).
  const wireUrl = normalizeProtocol(assembledWireUrl)
  const schemeAdded = wireUrl !== assembledWireUrl.trim()
  // The masked snapshot keeps `{secret:<name>}` masks legible (unencoded) while
  // still encoding the surrounding literal/plain segments — the wire above is
  // unaffected (it encodes the resolved plaintext).
  const assembledLogUrl = assembleQuery(
    logWithAuth.url,
    logWithAuth.params ?? [],
    resolvedSettings.encodeUrl,
    maskLog ? encodeQueryComponentPreservingMasks : undefined
  )
  const logUrl = schemeAdded ? `https://${assembledLogUrl.trim()}` : assembledLogUrl.trim()
  // Cookie snapshots name each hop's URL as it went on the wire, secrets and
  // all. The first hop is reported as the snapshot URL; a later hop (a redirect
  // target) gets the value mask.
  const maskCookies = (
    cookies: { sent: CookieSnapshot[]; received: CookieSnapshot[] },
    changes: EnvironmentChanges | undefined
  ): { sent: CookieSnapshot[]; received: CookieSnapshot[] } => {
    if (!maskLog) return cookies
    const mask = secretValueMask(changes)
    const hopUrl = (url: string): string => (url === wireUrl ? logUrl : mask(url))
    const each = (list: CookieSnapshot[]): CookieSnapshot[] =>
      list.map((c) => ({ ...c, url: hopUrl(c.url) }))
    return { sent: each(cookies.sent), received: each(cookies.received) }
  }

  // Binary bodies bypass form-field encoding entirely (binary uploads are a
  // single-file raw body, not a multi-part composition). `finalBody` is what
  // goes on the wire (secrets resolved); `logBody` is the masked counterpart
  // for the snapshot. Identical when there are no secrets.
  const finalBody = buildBody(wireResolved, binaryBody !== undefined)
  const logBody = buildBody(
    logResolved,
    binaryBody !== undefined,
    maskLog ? encodeQueryComponentPreservingMasks : undefined
  )

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
  const tlsVariables = activeSecrets
    ? { ...variables, ...activeSecrets.scriptEnvironment }
    : variables
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
  let exchange: ExchangeFacts | undefined
  try {
    ;({ response, rawSetCookie, exchange } = await sendRequestWithRaw(
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
        cookies: cookieSession,
        // Observation of the send's own connections and hops: the remote IP of
        // the activity log and, when asked for, the findings evaluation.
        observeExchange: true
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
        failedCookies = maskCookies(
          { sent: cookieSession.sent, received: cookieSession.offered },
          envChanges
        )
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
  } else {
    // The jar did not run for this send — no environment selected, the request
    // set its own `Cookie` header, or the jar is disabled. The response still
    // sent these, and hiding them because *we* chose not to store them would be
    // the tool withholding what it plainly observed. `stored` stays undefined:
    // nothing decided either way. Each cookie is attributed to the hop that
    // offered it, as the jar path does: the exchange records every hop's
    // `Set-Cookie`, while `rawSetCookie` holds only the final response's, which
    // is attributed to the final URL when no hop recorded any.
    const receivedAt = new Date()
    const offered = exchange?.hops.some((h) => h.setCookie.length > 0)
      ? exchange.hops.flatMap((h) => h.setCookie.map((header) => ({ header, url: h.url })))
      : rawSetCookie.map((header) => ({ header, url: exchange?.finalUrl ?? wireUrl }))
    receivedCookies = offered
      .map(({ header, url }) => snapshotFromSetCookie(header, url, receivedAt))
      .filter((c): c is CookieSnapshot => c !== null)
  }

  // 4. Post-response script — sees the UNMASKED response so it can legitimately
  // extract values (e.g. capture an auth token). Secret masking is applied to
  // the returned response afterwards.
  if (request.postResponseScript && request.postResponseScript.trim()) {
    const post = executePostResponse(request.postResponseScript, {
      request: { ...liveRequest, url: scriptUrl(liveRequest) },
      response,
      environment: scriptEnv,
      variables: scriptVars
    })
    scriptResults.postResponse = post.result
    envChanges = mergeEnvChanges(envChanges, post.result.environmentChanges)
  }

  const cookiesSummary =
    sentCookies.length > 0 || receivedCookies.length > 0
      ? maskCookies({ sent: sentCookies, received: receivedCookies }, envChanges)
      : undefined

  // Snapshot of the request as it went on the wire — but built from the masked
  // (`logResolved`) fields so secret values never reach the activity panel,
  // reporters, or `.runs/`. The multipart parts summary is the only place they
  // can see the encoded structure (file bytes are intentionally absent).
  // The overrides replace every case variant, as the wire does (the client drops
  // a user-typed `content-type` for the generated one), so the snapshot never
  // lists a header that was not sent.
  const headersForSnapshot: Record<string, string> = { ...logWithAuth.headers }
  if (cookieHeaderValue !== undefined) {
    setRecordHeaderUnique(headersForSnapshot, 'Cookie', cookieHeaderValue)
  }
  if (multipartEncoded) {
    setRecordHeaderUnique(headersForSnapshot, 'Content-Type', multipartEncoded.contentType)
  }

  // Collect from the marker-bearing `resolved` fields (markers are gone in
  // `logResolved`, already replaced by `{secret:<name>}`). The auth config is
  // scanned separately: its markers live on `resolvedAuth`, not on `resolved`,
  // because the credential is materialized after the render split.
  const markerMaskedNames = activeSecrets
    ? activeSecrets.collectMaskedNames([
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
  const secretsMasked = [
    ...markerMaskedNames,
    ...[...valueMaskedNames].filter((n) => !markerMaskedNames.includes(n))
  ]

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
  // Passive security findings: evaluated over what the send already observed —
  // its final hop as sent, every hop's `Set-Cookie`, the final response as
  // received and the connection that delivered it. A defect in the evaluation is
  // contained here: the send keeps its result, and the failure is surfaced.
  const findingsWarnings: ExecutionWarning[] = []
  let findings: ExecutedRequestResult['findings']
  if (options.evaluateFindings && exchange) {
    try {
      const finalHop = exchange.hops[exchange.hops.length - 1]
      findings = evaluateFindings(
        {
          finalUrl: exchange.finalUrl,
          requestHeaders: finalHop?.requestHeaders ?? [],
          response: {
            headers: response.headers,
            hasBody: (response.compressedBytes ?? response.sizeBytes) > 0
          },
          hops: exchange.hops.map((h) => ({ url: h.url, setCookie: h.setCookie })),
          ...(exchange.finalConnection?.tls ? { tls: exchange.finalConnection.tls } : {}),
          verifySsl: resolvedSettings.verifySsl,
          // Only its header / parameter *name* is read, so the wire render is fine.
          ...(resolvedAuth.auth
            ? {
                auth: activeSecrets
                  ? mapAuthStrings(resolvedAuth.auth, activeSecrets.wireRender)
                  : resolvedAuth.auth
              }
            : {})
        },
        resolveFindingsSettings(resolvedSettings.findings),
        new Date()
      )
    } catch {
      findings = { status: 'failed' }
      findingsWarnings.push({ code: 'FINDINGS_EVALUATION_FAILED' })
    }
  }
  // The remote address is the server's only on a direct connection: through a
  // proxy the socket's peer is the proxy, and recording it would mislead.
  const remoteIp =
    exchange?.finalVia === 'direct' ? exchange.finalConnection?.remoteAddress : undefined

  // The per-value `headerList` is for the post-response script only: it is
  // transport-only, so it never leaves the send (nor needs masking).
  const received = { ...response }
  delete received.headerList
  const responseMask = secretValueMask(envChanges)
  const maskedBody = responseMask(received.body)
  const maskedHeaders = Object.fromEntries(
    Object.entries(received.headers).map(([k, v]) => [k, responseMask(v)])
  )
  // The raw `Set-Cookie` list is what the run file writes, one line each.
  const maskedSetCookie = received.setCookie?.map(responseMask)
  const responseChanged =
    maskedBody !== received.body ||
    Object.entries(maskedHeaders).some(([k, v]) => v !== received.headers[k]) ||
    (maskedSetCookie ?? []).some((v, i) => v !== received.setCookie![i])
  const maskedResponse = responseChanged
    ? {
        ...received,
        body: maskedBody,
        headers: maskedHeaders,
        ...(maskedSetCookie ? { setCookie: maskedSetCookie } : {})
      }
    : received

  return {
    response: maskedResponse,
    ...(options.revealResponse && responseChanged ? { unmaskedResponse: received } : {}),
    scriptResults: maskedScripts(scriptResults, envChanges),
    environmentChanges: envChanges,
    resolvedSettings,
    cookies: cookiesSummary,
    request: snapshot,
    // REQ-0068's remote IP, observed on the connection itself (see above). The
    // activity-log serializer omits `# @remote-ip` when this is undefined.
    ...(remoteIp ? { remoteIp } : {}),
    ...(findings ? { findings } : {}),
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
      transportWarnings.length +
      findingsWarnings.length >
    0
      ? {
          warnings: [
            ...queryWarnings,
            ...unresolvedWarnings,
            ...cookieWarnings,
            ...transportWarnings,
            ...findingsWarnings
          ]
        }
      : {})
  }
}
