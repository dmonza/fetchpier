import { promises as fs } from 'node:fs'
import { relative } from 'node:path'
import { CoreError, describeError, requests, secrets, tls, workspace } from '@fetchpier/core'
import type {
  CookieRejectionReason,
  ExecutedRequestResult,
  ExecutionWarning,
  HistoryEntry,
  HttpRequest
} from '@shared/types'
import { cliUserAgent } from '@shared/types'
import { CLI_VERSION } from '../../version'
import { DEFAULT_TIMEOUT_MS, MAX_TIMER_MS } from '../run-options'
import { CliError } from '../../errors'
import { EXIT } from '../../exit-codes'
import { resolveWorkspace } from '../../context/resolve-workspace'
import { resolveEnvironment } from '../../context/resolve-environment'
import { resolveTlsConfig } from '../../context/resolve-tls-config'
import { createReporters, type ReporterBuildContext } from '../../reporters'
import type { Reporter } from '../../reporters/types'
import type { RequestUnit, ReporterConfig, RunOptions, RunSummary } from '../../types'
import { expandPaths } from './expand-paths'
import { toRequestUnit, type ResolvedRequestView } from './to-unit'
import type { ApiKeyCredential } from '../../output/formatters'

/**
 * Build the post-resolution request view for display (URL, headers, body).
 * This is only a fallback for the reporter when `execute` produced no wire
 * snapshot (e.g. a pre-request script aborted). When a masker is present, secret
 * markers are log-rendered to `{secret:<name>}` so no plaintext appears.
 */
function resolveForDisplay(
  request: HttpRequest,
  variables: Record<string, string>,
  masker?: SecretMasker
): ResolvedRequestView {
  const vars = request.variables ?? variables
  const mask = (s: string | undefined): string | undefined =>
    s !== undefined && masker ? masker.logRender(s) : s

  // Same order as the send pipeline (REQ-0111): resolve the auth config's own
  // fields, resolve the request, render the masked side, and only then
  // materialize the credential. Materializing first would base64 / percent-encode
  // the `{{reference}}` (or the secret marker) out of existence, and this view
  // would disagree with what was actually sent.
  const resolvedAuth = requests.resolveAuthConfig(request.auth, vars)
  const resolved = requests.resolveRequestVariables(request, vars)
  const logged = {
    url: mask(resolved.url) ?? resolved.url,
    headers: masker
      ? Object.fromEntries(
          Object.entries(resolved.headers).map(([k, v]) => [
            masker.logRender(k),
            masker.logRender(v)
          ])
        )
      : resolved.headers
  }
  const withAuth = requests.applyAuth(
    logged,
    masker ? requests.mapAuthStrings(resolvedAuth.auth, masker.logRender) : resolvedAuth.auth,
    masker ? requests.MASK_PRESERVING_MATERIALIZATION : {}
  )

  return {
    method: resolved.method,
    url: withAuth.url,
    headers: withAuth.headers,
    body: mask(resolved.body)
  }
}

type SecretMasker = secrets.SecretMasker

/** The (resolved) name and location of the request's API-key credential, if it has one. */
function apiKeyCredentialOf(request: HttpRequest): ApiKeyCredential | undefined {
  if (request.auth?.type !== 'api-key') return undefined
  const { auth } = requests.resolveAuthConfig(request.auth, request.variables ?? {})
  if (auth?.type !== 'api-key' || !auth.key) return undefined
  return { location: auth.location, name: auth.key }
}

/**
 * The workspace key from `FETCHPIER_WORKSPACE_KEY`, validated against the
 * workspace challenge up front (a wrong key is fatal before anything is sent).
 * `null` when the variable is absent or the workspace has no secrets. Custody
 * stays here; the core asks for it lazily through the variable session.
 */
async function loadWorkspaceKey(
  manifest: Awaited<ReturnType<workspace.Workspace['secrets']['readManifest']>>,
  env: NodeJS.ProcessEnv
): Promise<Uint8Array | null> {
  const keyInput = env.FETCHPIER_WORKSPACE_KEY?.trim()
  if (!manifest || !keyInput) return null
  // `parseKey` throws SECRETS_KEY_INVALID on a CRC failure (before any
  // challenge attempt).
  const rawKey = secrets.parseKey(keyInput)
  if (!(await secrets.verifyKeyAgainstChallenge(rawKey, manifest))) {
    throw secrets.keyInvalidError(manifest.encryption.keyId)
  }
  return rawKey
}

/**
 * Spell out a non-fatal engine advisory for a human. The structured payload
 * travels alongside it (the JSON report carries `code`), so this wording is free
 * to change. Payloads name variables, cookies and hosts — never values.
 */
function describeWarning(relPath: string, w: ExecutionWarning): string {
  switch (w.code) {
    case 'MALFORMED_QUERY_ENCODING':
      return (
        `${relPath}: query parameter "${w.rawKey}" could not be decoded ` +
        `(malformed percent-encoding); it was sent literally.`
      )
    case 'UNRESOLVED_VARIABLE':
      // Advisory, not a failure: the reference was sent literally, which the
      // server will almost certainly reject — saying so is the whole point.
      return (
        `${relPath}: variable "${w.name}" has no value in this environment; ` +
        `the reference was sent literally.`
      )
    case 'COOKIE_REJECTED':
      return `${relPath}: ${describeCookieRejection(w.name, w.host, w.reason)}`
    case 'COOKIE_CROSS_SITE_INSECURE':
      return (
        `${relPath}: cookie "${w.name}" from ${w.host} sets SameSite=None without ` +
        `Secure; it was stored, but a browser would reject it.`
      )
    case 'COOKIE_JAR_UNAVAILABLE':
      return w.phase === 'read'
        ? `${relPath}: the cookie jar could not be read; the request was sent without stored cookies (${w.reason}).`
        : `${relPath}: the cookie jar could not be saved; cookies set by this response were not stored (${w.reason}).`
    case 'TLS_MATERIAL_UNAVAILABLE':
      return `${relPath}: TLS: ${w.reason}; the request was sent without it.`
    case 'RESPONSE_DECODING_FAILED':
      return (
        `${relPath}: the response body could not be decoded (${w.encoding}: ${w.reason}); ` +
        `it is kept as received.`
      )
    case 'UNSUPPORTED_CONTENT_ENCODING':
      return (
        `${relPath}: the response uses an unsupported content encoding (${w.encoding}); ` +
        `the body is kept as received.`
      )
    case 'HTTP2_DOWNGRADED':
      return `${relPath}: HTTP/2 was requested over plain HTTP; HTTP/1.1 was used.`
    case 'CONTENT_TYPE_REPLACED':
      return `${relPath}: the Content-Type header was replaced by the multipart encoder's own (it owns the boundary).`
    case 'UNDEFINED_ENV_REFERENCE':
      return (
        `${relPath}: variable "${w.name}" comes from {{$env.${w.envName}}}, which is not ` +
        `defined in .env or the environment; it was sent empty.`
      )
    case 'ENV_WRITE_NOT_PERSISTED':
      return w.reason === 'KEY_MISSING'
        ? `${relPath}: secret variable "${w.name}" was set by a script but not saved to the local values: ` +
            `no workspace key is available (set FETCHPIER_WORKSPACE_KEY). It is still used for the rest of this run.`
        : `${relPath}: secret variable "${w.name}" was set by a script but not saved: this environment's local ` +
            `values are encrypted with a previous workspace key. Open the workspace in the desktop app with the ` +
            `new key so it re-encrypts them. The value is still used for the rest of this run.`
  }
}

/**
 * REQ-0115 — plain-language reason a cookie was refused. Deliberately not the
 * specification's wording: the reader is someone whose request just did not get
 * the cookie they expected, and "domain-match failed per §5.3" tells them
 * nothing actionable.
 */
function describeCookieRejection(
  name: string,
  host: string,
  reason: CookieRejectionReason
): string {
  const which = `cookie "${name}" from ${host}`
  switch (reason) {
    case 'DOMAIN_MISMATCH':
      return `${which} was rejected: its Domain names a host this server has no authority over.`
    case 'PUBLIC_SUFFIX':
      return `${which} was rejected: its Domain is a public suffix, which would match every host under it.`
    case 'PREFIX_VIOLATION':
      return `${which} was rejected: its name carries a reserved security prefix whose rules its attributes do not satisfy.`
    case 'INSECURE_OVERWRITE':
      return `${which} was rejected: it arrived over an insecure connection and would have replaced a Secure cookie.`
    case 'MALFORMED':
      return `${which} was rejected: the Set-Cookie header could not be parsed.`
    default:
      return `${which} was rejected by the cookie jar.`
  }
}

function assertNonNegativeInteger(name: string, value: number | undefined): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(
      EXIT.USAGE,
      `Invalid value for ${name}: ${JSON.stringify(value)} (expected a whole number of milliseconds, 0 or more)`
    )
  }
  if (value > MAX_TIMER_MS) {
    throw new CliError(
      EXIT.USAGE,
      `Invalid value for ${name}: ${value} (the maximum is ${MAX_TIMER_MS} ms)`
    )
  }
}

function toForwardSlashes(p: string): string {
  return p.split('\\').join('/')
}

/** Reporter wiring derived from a {@link RunOptions}. Tests override the sinks. */
export interface RunDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  reporterContext?: Partial<ReporterBuildContext>
}

/**
 * Canonical implementation of `fp request run`. Resolves the workspace and
 * environment, expands the input paths, runs each request through
 * `core.requests.execute`, and drives the reporters. Returns the structured
 * {@link RunSummary}. Fatal conditions throw `CliError`/`CoreError` (mapped to
 * exit codes by the binary); request/test/script failures are reported in-band.
 */
export async function executeRun(options: RunOptions, deps: RunDeps = {}): Promise<RunSummary> {
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env

  // The programmatic API gets the binary's validation too: a value that cannot
  // be honoured is refused, never silently ignored.
  assertNonNegativeInteger('timeoutMs', options.timeoutMs)
  assertNonNegativeInteger('delay', options.delay)
  if (options.proxy !== undefined && options.noProxy) {
    throw new CliError(EXIT.USAGE, 'proxy and noProxy cannot be used together')
  }

  const workspacePath = resolveWorkspace({ flag: options.workspace, env, cwd })
  const resolvedEnv = await resolveEnvironment({ flag: options.environment, env, workspacePath })
  // REQ Core-owned workspace handle (F10): one ephemeral handle per run; all
  // workspace reads/writes go through it (the CLs stays read-only-ish: it only
  // writes history when `--save-history` is set).
  const ws = workspace.openWorkspace(workspacePath)

  // Workspace HTTP defaults (the `--insecure` override is applied below). Strict:
  // an unparseable settings file stops the run (exit 4) instead of silently
  // running with defaults — which would drop its TLS material and HTTP settings.
  const workspaceSettings = await ws.settings.loadStrict()

  // REQ-0070: the key comes exclusively from FETCHPIER_WORKSPACE_KEY (CI-native,
  // mirrors SOPS_AGE_KEY), validated up front; the core asks for it lazily — a
  // request touching no secret needs none.
  const rawKey = await loadWorkspaceKey(await ws.secrets.readManifest(), env)

  // The core owns the run's variables: the layering (shared with `{{$env.*}}`
  // resolved → per-machine local values → `--env-var`) and the carry-forward of
  // every script write to the requests that follow. By default the changes live
  // for this run only — a CI run never writes to the workspace and never depends
  // on what a previous run left behind; `--persist-env` writes them into the
  // local values exactly as the desktop does.
  const session = await requests.createVariableSession({
    workspace: ws,
    environmentId: resolvedEnv.id,
    overrides: options.envVars ?? {},
    processEnv: env,
    getKey: async () => rawKey,
    persistence: options.persistEnv ? 'persist' : 'memory'
  })

  // Proxy routing from `--proxy` / `--no-proxy` and HTTPS_PROXY / HTTP_PROXY /
  // NO_PROXY. An unusable URL is fatal here, before anything is sent.
  const proxyRouting = requests.resolveProxyRouting({
    flag: options.proxy,
    noProxy: options.noProxy,
    env
  })

  // TLS material given for this run only (`--tls-config` / FETCHPIER_TLS_CONFIG):
  // certificates that belong to the machine or the pipeline, not the workspace.
  // An unusable file is fatal here, before anything is sent.
  const runTls = await resolveTlsConfig({ flag: options.tlsConfig, env, cwd })

  // Explicit paths resolve against cwd; with none, the target is the workspace's
  // own `requests/` tree — the same from any directory (see `expandPaths`).
  const files = await expandPaths(options.paths, cwd, workspacePath)

  if (options.insecure) workspaceSettings.verifySsl = false

  const reporterConfigs: ReporterConfig[] = options.reporters?.length
    ? options.reporters
    : [{ type: 'cli' }]
  const reporters = createReporters(reporterConfigs, {
    ascii: options.ascii ?? false,
    noColor: options.noColor ?? false,
    silent: options.silent ?? false,
    showSecrets: options.showSecrets ?? false,
    ...deps.reporterContext
  })

  const startedAt = new Date()
  const units: RequestUnit[] = []
  let scriptErrors = 0

  const meta = {
    workspace: workspacePath,
    environment: resolvedEnv.id,
    environmentName: resolvedEnv.folder,
    cliVersion: CLI_VERSION,
    startedAt: startedAt.toISOString(),
    plannedUnits: await countPlannedUnits(files),
    verbosity: options.verbosity ?? 0,
    showSecrets: options.showSecrets ?? false,
    ...(proxyRouting.active ? { proxy: proxyRouting.active } : {})
  }
  emit(reporters, (r) => r.runStart(meta))

  // REQ-0074/0076: the CLI never re-wraps or removes orphans (that would mutate
  // the working tree in CI). Encrypted overrides under a stale keyId are ignored
  // for this run — resolution falls back to the shared value.
  if (session.orphans.length > 0) {
    emit(reporters, (r) =>
      r.warn(
        `local override(s) ${session.orphans.join(', ')} in environment ` +
          `"${resolvedEnv.folder}" were written under a different workspace key and are ignored ` +
          `for this run; resolution falls back to the shared value.`
      )
    )
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const userAgent = cliUserAgent(CLI_VERSION)

  let bailed = false
  for (const file of files) {
    if (bailed || options.signal?.aborted) break
    const content = await fs.readFile(file, 'utf-8')
    const parsed = requests.parseHttpFile(content)
    const relPath = toForwardSlashes(relative(workspacePath, file)) || toForwardSlashes(file)

    // Load-time diagnostics (a malformed `# @auth` block, an invalid binary
    // reference, an unknown setting) — informational, the file still loads.
    for (const w of parsed.warnings ?? []) emit(reporters, (r) => r.warn(`${relPath}: ${w}`))

    // `.http` round-trip fidelity (D14): a file may hold multiple requests, but
    // both surfaces execute only the first. Surface an informational advisory
    // (non-fatal) when additional requests are present and skipped.
    if (parsed.requests.length > 1) {
      emit(reporters, (r) =>
        r.warn(
          `${relPath}: file contains ${parsed.requests.length} requests; only the first is executed ` +
            `(the rest are preserved on disk).`
        )
      )
    }

    // A `.http` file the runner was asked to execute, that yields no request, is
    // a failure of the workspace — not a success with nothing to do. It used to
    // contribute no unit at all, so a run whose files were all unparseable
    // reported "0 requests" and exited 0. Reported as a failed unit so it reaches
    // the summary, every report, and the exit code; the run continues to the
    // next file, matching how every other per-file problem is contained.
    if (parsed.requests.length === 0) {
      emit(reporters, (r) =>
        r.warn(
          `${relPath}: no request found; the file is empty, holds only comments, or its ` +
            `request line could not be parsed.`
        )
      )
      const unit: RequestUnit = {
        type: 'request',
        path: relPath,
        name: relPath,
        // There is no request to describe. The path is what identifies the unit,
        // and the reporters render it in the slot a method+URL would occupy.
        request: { method: '', url: relPath, headers: {} },
        scripts: {},
        tests: [],
        error: 'no request found in this file',
        notRun: true,
        durationMs: 0
      }
      units.push(unit)
      emit(reporters, (r) =>
        r.unitStart({ path: relPath, name: relPath, method: '', urlTemplate: relPath })
      )
      emit(reporters, (r) => r.unitComplete(unit))
      if (options.bail) bailed = true
      continue
    }

    for (const parsedRequest of parsed.requests.slice(0, 1)) {
      if (bailed || options.signal?.aborted) break

      // The session supplies this request's variables — including everything the
      // scripts of earlier requests wrote — and resolves the secrets it
      // references (throws contractual SECRETS_* → mapped to an exit code).
      const prepared = await session.prepare(parsedRequest)
      const request: HttpRequest = prepared.request
      const masker = prepared.masker
      const resolved = resolveForDisplay(request, request.variables ?? {}, masker)

      emit(reporters, (r) =>
        r.unitStart({
          path: relPath,
          name: `${request.method} ${request.url}`,
          method: request.method,
          urlTemplate: request.url
        })
      )

      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // `0` is the only way to run without a timeout. The abort reason lets the
      // engine report "timed out after …" instead of a cancellation.
      const timer =
        timeoutMs > 0
          ? setTimeout(() => controller.abort(requests.timeoutAbortReason(timeoutMs)), timeoutMs)
          : undefined

      const t0 = Date.now()
      let result: ExecutedRequestResult
      try {
        result = await requests.execute(request, {
          environmentId: resolvedEnv.id,
          workspaceSettings,
          signal: controller.signal,
          userAgent,
          proxy: proxyRouting.proxyFor,
          secretNames: prepared.secretNames,
          // `--show-secrets` shows the response as received in the terminal and
          // the reports; `result.response` stays masked for `--save-history`.
          revealResponse: options.showSecrets ?? false,
          // REQ-0066: multipart parts read from `requests/.files/` inside the
          // workspace. Always pass through; core ignores it for other body modes.
          workspacePath: ws.path,
          // REQ-0089: workspace TLS parity — core composes the workspace client
          // cert + CA bundle from the path and resolves the passphrase like the
          // desktop. No app-global material (it lives outside the workspace).
          resolveTls: (url, tlsEnv, onWarning) =>
            tls.resolveRequestTls(url, tlsEnv, {
              workspacePath,
              ...(runTls ? { run: runTls } : {}),
              resolvePassphraseSecrets: prepared.resolvePassphraseSecrets,
              ...(onWarning ? { onWarning } : {})
            }),
          // REQ-0070: secret masking for this send (undefined when the request
          // references no secret).
          secrets: masker
        })
      } catch (err) {
        // A contractual failure stays fatal and keeps its own exit code: an
        // unmet secret precondition means the run cannot proceed, unlike a
        // request that merely failed to reach its server. Only uncoded errors
        // are reported in-band.
        if (err instanceof CoreError) throw err
        // REQ-0111: a failure to SEND is a run outcome, not a fatal condition.
        // An unreachable host, an expired timeout, a TLS failure or an interrupt
        // in flight all surface here as ordinary errors carrying no contractual
        // code, and the binary's top-level handler would classify anything
        // uncoded as an internal defect — printing a stack trace and a
        // bug-report invitation for a service that was simply down, and aborting
        // before the summary or any report file was written. Reporting it in-band
        // keeps the promise this function's docblock already makes.
        // The reason comes from core, never from `.message` here: a failure
        // carrying an empty message would give the unit no reason at all, and
        // the reporters print one only when it is present — `request not sent`
        // with nothing after it. Unreachable for transport failures today
        // (the pipeline reports those in-band, already described); this keeps
        // the seam from reintroducing the hole for anything that escapes it.
        result = { error: describeError(err) }
      } finally {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const durationMs = Date.now() - t0

      // Non-fatal advisories (REQ-0086 / REQ-0111 / REQ-0115 and the transport,
      // TLS and decoding ones): none moves the exit code. The structured payload
      // rides along for machine-readable reporters.
      for (const w of [...prepared.warnings, ...(result.warnings ?? [])]) {
        emit(reporters, (r) => r.warn(describeWarning(relPath, w), w))
      }

      // Carry this request's environment writes to every later request (and,
      // with --persist-env, into the local values). A pre-request script that
      // failed still contributes what it wrote, as on the desktop.
      for (const w of await session.apply(result.environmentChanges)) {
        emit(reporters, (r) => r.warn(describeWarning(relPath, w), w))
      }

      const unit = toRequestUnit({
        path: relPath,
        resolved,
        result,
        durationMs,
        showSecrets: options.showSecrets ?? false,
        apiKey: apiKeyCredentialOf(request)
      })
      // With a proxy configured, record whether this request used it — an
      // exclusion (`NO_PROXY`) can send it direct.
      if (proxyRouting.active) {
        unit.via = proxyRouting.proxyFor(result.request?.url ?? resolved.url) ? 'proxy' : 'direct'
      }
      units.push(unit)

      const hadScriptError =
        (unit.scripts.preRequest?.errors.length ?? 0) > 0 ||
        (unit.scripts.postResponse?.errors.length ?? 0) > 0
      if (hadScriptError) scriptErrors += 1

      emit(reporters, (r) => r.unitComplete(unit))

      if (options.saveHistory && result.response) {
        await saveHistory(ws, request, unit, result)
      }

      // Same predicate `buildSummary` uses for a failed request: a request that
      // produced no response (unreachable host, timeout, TLS) stops a bail run
      // like a failed assertion does.
      const hadFailure = unit.tests.some((t) => !t.passed) || hadScriptError || !unit.response
      if (options.bail && hadFailure) bailed = true
      if (options.delay && options.delay > 0 && !bailed) await sleep(options.delay)
    }
  }

  const endedAt = new Date()
  const summary = buildSummary(units, scriptErrors, {
    workspace: workspacePath,
    environment: resolvedEnv.id,
    environmentName: resolvedEnv.folder,
    startedAt,
    endedAt
  })

  emit(reporters, (r) => r.runComplete(summary))
  for (const r of reporters) await r.finalize()

  return summary
}

async function countPlannedUnits(files: string[]): Promise<number> {
  // Exact, not a heuristic: the runner executes only the FIRST request of each
  // file (the rest are preserved on disk and advised about), so one file plans
  // exactly one unit. The actual count can end up lower — `--bail` or an
  // interrupt truncates the run — which is the normal meaning of "planned".
  // Never leaves the process: the only consumer is the reporter's single-vs-multi
  // layout choice; it is not part of the run summary.
  return files.length
}

function buildSummary(
  units: RequestUnit[],
  scriptErrors: number,
  ctx: {
    workspace: string
    environment: string
    environmentName: string
    startedAt: Date
    endedAt: Date
  }
): RunSummary {
  let testsPassed = 0
  let testsFailed = 0
  let requestsPassed = 0
  let requestsFailed = 0
  for (const u of units) {
    const failedTests = u.tests.filter((t) => !t.passed).length
    testsPassed += u.tests.length - failedTests
    testsFailed += failedTests
    const unitFailed =
      failedTests > 0 ||
      (u.scripts.preRequest?.errors.length ?? 0) > 0 ||
      (u.scripts.postResponse?.errors.length ?? 0) > 0 ||
      !u.response
    if (unitFailed) requestsFailed += 1
    else requestsPassed += 1
  }

  return {
    schemaVersion: '1.0',
    fetchpier: { cliVersion: CLI_VERSION },
    workspace: ctx.workspace,
    environment: ctx.environment,
    environmentName: ctx.environmentName,
    startedAt: ctx.startedAt.toISOString(),
    endedAt: ctx.endedAt.toISOString(),
    durationMs: ctx.endedAt.getTime() - ctx.startedAt.getTime(),
    summary: {
      requests: { total: units.length, passed: requestsPassed, failed: requestsFailed },
      tests: { total: testsPassed + testsFailed, passed: testsPassed, failed: testsFailed },
      scriptErrors
    },
    units
  }
}

async function saveHistory(
  ws: workspace.Workspace,
  request: HttpRequest,
  unit: RequestUnit,
  result: {
    response?: HistoryEntry['response']
    request?: HistoryEntry['wireRequest']
    scriptResults?: HistoryEntry['scriptResults']
    resolvedSettings?: HistoryEntry['resolvedSettings']
    cookies?: HistoryEntry['cookies']
    remoteIp?: HistoryEntry['remoteIp']
  }
): Promise<void> {
  if (!result.response) return
  const entry: HistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    request,
    // REQ-0070: the wire snapshot is already masked (secret values rendered as
    // `{secret:<name>}`) and carries `secretsMasked` for the directive.
    wireRequest: result.request,
    response: result.response,
    sourceFile: unit.path,
    scriptResults: result.scriptResults,
    resolvedSettings: result.resolvedSettings,
    cookies: result.cookies,
    remoteIp: result.remoteIp
  }
  await ws.history.save(entry)
}

function emit(reporters: Reporter[], fn: (r: Reporter) => void): void {
  for (const r of reporters) fn(r)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
