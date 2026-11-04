import { promises as fs } from 'node:fs'
import { relative } from 'node:path'
import { CoreError, describeError, requests, secrets, tls, workspace } from '@fetchpier/core'
import type {
  CookieRejectionReason,
  ExecutedRequestResult,
  HistoryEntry,
  HttpRequest
} from '@shared/types'
import { CLI_VERSION } from '../../version'
import { resolveWorkspace } from '../../context/resolve-workspace'
import { resolveEnvironment } from '../../context/resolve-environment'
import { createReporters, type ReporterBuildContext } from '../../reporters'
import type { Reporter } from '../../reporters/types'
import type { RequestUnit, ReporterConfig, RunOptions, RunSummary } from '../../types'
import { expandPaths } from './expand-paths'
import { toRequestUnit, type ResolvedRequestView } from './to-unit'

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

/**
 * Per-run secret context: the environment's secret map, the manifest, and the
 * workspace key from `FETCHPIER_WORKSPACE_KEY` (validated against the challenge).
 * Built once; `maskerFor` resolves the secrets a single request references.
 */
interface SecretContext {
  secretsMap: Record<string, string | null>
  environmentId: string
  hasKey: boolean
  maskerFor(request: HttpRequest): Promise<SecretMasker | undefined>
  /**
   * REQ-0089: decrypt the secrets a client-certificate passphrase references,
   * lazily (invoked only after a workspace cert with a secret passphrase is
   * matched). Returns plaintext for *secret* names only; throws the contractual
   * `SECRETS_*` errors. No key needed when no referenced name is a secret.
   */
  resolveNames(names: string[]): Promise<Record<string, string>>
}

async function buildSecretContext(
  environmentId: string,
  secretsMap: Record<string, string | null>,
  manifest: Awaited<ReturnType<workspace.Workspace['secrets']['readManifest']>>,
  env: NodeJS.ProcessEnv
): Promise<SecretContext> {
  let rawKey: Uint8Array | null = null

  const keyInput = env.FETCHPIER_WORKSPACE_KEY?.trim()
  if (manifest && keyInput) {
    // `parseKey` throws SECRETS_KEY_INVALID on a CRC failure (before any
    // challenge attempt).
    rawKey = secrets.parseKey(keyInput)
    if (!(await secrets.verifyKeyAgainstChallenge(rawKey, manifest))) {
      throw secrets.keyInvalidError(manifest.encryption.keyId)
    }
  }

  return {
    secretsMap,
    environmentId,
    hasKey: rawKey !== null,
    async maskerFor(request: HttpRequest): Promise<SecretMasker | undefined> {
      const neededNames = secrets.collectReferencedVariableNames(request)
      const plaintextByName = await secrets.resolveSecrets({
        environmentId,
        secretsMap,
        neededNames,
        hasKey: rawKey !== null,
        decrypt: (name, encValue) => secrets.decryptValue(rawKey as Uint8Array, name, encValue)
      })
      if (Object.keys(plaintextByName).length === 0) return undefined
      return secrets.createSecretMasker({ nonce: secrets.mintExecutionNonce(), plaintextByName })
    },
    async resolveNames(names: string[]): Promise<Record<string, string>> {
      if (names.length === 0) return {}
      const referencesSecret = names.some((n) =>
        Object.prototype.hasOwnProperty.call(secretsMap, n)
      )
      if (!referencesSecret) return {}
      return secrets.resolveSecrets({
        environmentId,
        secretsMap,
        neededNames: names,
        hasKey: rawKey !== null,
        decrypt: (name, encValue) => secrets.decryptValue(rawKey as Uint8Array, name, encValue)
      })
    }
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

  const workspacePath = resolveWorkspace({ flag: options.workspace, env, cwd })
  const resolvedEnv = await resolveEnvironment({ flag: options.environment, env, workspacePath })
  // REQ Core-owned workspace handle (F10): one ephemeral handle per run; all
  // workspace reads/writes go through it (the CLs stays read-only-ish: it only
  // writes history when `--save-history` is set).
  const ws = workspace.openWorkspace(workspacePath)

  // REQ-0074/0076: merge the per-machine local value layer (`.state/localvalues.json`).
  // The CLI is read-only: it never re-wraps or removes orphans (that would mutate
  // the working tree in CI). Encrypted overrides under a stale keyId are treated
  // as orphans for this run — a stderr warning, then fall back to shared.
  const manifest = await ws.secrets.readManifest()
  const currentKeyId = manifest?.encryption.keyId
  const localValues = await ws.secrets.readLocalValues(resolvedEnv.id)
  const merged = secrets.mergeEnvironmentLayers(
    { variables: resolvedEnv.variables },
    localValues,
    currentKeyId
  )
  if (merged.orphans.length > 0) {
    process.stderr.write(
      `fp: warning: local override(s) ${merged.orphans.join(', ')} in environment ` +
        `"${resolvedEnv.id}" were written under a different workspace key and are ignored ` +
        `for this run; resolution falls back to the shared value.\n`
    )
  }

  // REQ-0067: resolve `{{$env.NAME}}` references in the SHARED environment values
  // BEFORE overlaying local values (literal) and `--env-var` overrides (literal,
  // highest precedence). Identical ordering to the desktop's `http:send`. REQ-0076:
  // only the *plain* shared entries are interpolation variables; secret-shaped
  // (`enc:`/`null`) values resolve through the masker.
  const sharedPlain: Record<string, string> = {}
  for (const [name, value] of Object.entries(resolvedEnv.variables)) {
    if (typeof value === 'string' && !secrets.isEncryptedValue(value)) sharedPlain[name] = value
  }
  const envResolvedVars = await ws.dotenv.resolveReferences(sharedPlain, env)
  const localPlainOverlay: Record<string, string> = {}
  for (const [name, value] of Object.entries(localValues.variables)) {
    if (secrets.classifyLocalWrite(name, resolvedEnv.variables) === 'plain') {
      localPlainOverlay[name] = value
    }
  }
  const variables: Record<string, string> = {
    ...envResolvedVars,
    ...localPlainOverlay,
    ...(options.envVars ?? {})
  }

  // REQ-0070/0074: secret variables, resolved over the MERGED secret map (local
  // encrypted overrides win). The key comes exclusively from
  // FETCHPIER_WORKSPACE_KEY (CI-native, mirrors SOPS_AGE_KEY). Resolution is
  // lazy — a request touching no secret needs no key.
  const secretContext = await buildSecretContext(resolvedEnv.id, merged.secretsMap, manifest, env)

  // Explicit paths resolve against cwd; with none, the target is the workspace's
  // own `requests/` tree — the same from any directory (see `expandPaths`).
  const files = await expandPaths(options.paths, cwd, workspacePath)

  // Workspace HTTP defaults, with the `--insecure` override applied for the run.
  const workspaceSettings = await ws.settings.load()
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
    cliVersion: CLI_VERSION,
    startedAt: startedAt.toISOString(),
    plannedUnits: await countPlannedUnits(files),
    verbosity: options.verbosity ?? 0,
    showSecrets: options.showSecrets ?? false
  }
  emit(reporters, (r) => r.runStart(meta))

  let bailed = false
  for (const file of files) {
    if (bailed || options.signal?.aborted) break
    const content = await fs.readFile(file, 'utf-8')
    const parsed = requests.parseHttpFile(content)
    const relPath = toForwardSlashes(relative(workspacePath, file)) || toForwardSlashes(file)

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

      const request: HttpRequest = { ...parsedRequest, variables }
      // Resolve the secrets this request references (throws contractual
      // SECRETS_* on failure → mapped to an exit code by the binary).
      const masker = await secretContext.maskerFor(request)
      if (masker) request.variables = { ...variables, ...masker.markerVariables }
      const resolved = resolveForDisplay(request, variables, masker)

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
      const timer =
        options.timeoutMs && options.timeoutMs > 0
          ? setTimeout(() => controller.abort(), options.timeoutMs)
          : undefined

      const t0 = Date.now()
      let result: ExecutedRequestResult
      try {
        result = await requests.execute(request, {
          environmentId: resolvedEnv.id,
          workspaceSettings,
          signal: controller.signal,
          // REQ-0066: multipart parts read from `requests/.files/` inside the
          // workspace. Always pass through; core ignores it for other body modes.
          workspacePath: ws.path,
          // REQ-0089: workspace TLS parity — core composes the workspace client
          // cert + CA bundle from the path and resolves the passphrase like the
          // desktop. No app-global material (it lives outside the workspace).
          resolveTls: (url, env) =>
            tls.resolveRequestTls(url, env, {
              workspacePath,
              resolvePassphraseSecrets: (names) => secretContext.resolveNames(names)
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

      // REQ-0086: surface non-fatal load warnings (e.g. a malformed query
      // parameter kept raw and sent literally). Non-fatal — the exit code is
      // not affected by this cause; the payload is the raw key and its position.
      for (const w of result.warnings ?? []) {
        if (w.code === 'MALFORMED_QUERY_ENCODING') {
          emit(reporters, (r) =>
            r.warn(
              `${relPath}: query parameter "${w.rawKey}" could not be decoded ` +
                `(malformed percent-encoding); it was sent literally.`,
              w
            )
          )
        } else if (w.code === 'UNRESOLVED_VARIABLE') {
          // Advisory, not a failure: the reference was sent literally, which the
          // server will almost certainly reject — saying so is the whole point.
          emit(reporters, (r) =>
            r.warn(
              `${relPath}: variable "${w.name}" has no value in this environment; ` +
                `the reference was sent literally.`,
              w
            )
          )
        } else if (w.code === 'COOKIE_REJECTED') {
          // REQ-0115: the jar refused a cookie the server offered. Advisory —
          // it says something about the response, not about the run, so the
          // exit code is untouched. The reason is spelled out rather than left
          // as a specification clause the reader would have to look up.
          emit(reporters, (r) =>
            r.warn(`${relPath}: ${describeCookieRejection(w.name, w.host, w.reason)}`, w)
          )
        } else if (w.code === 'COOKIE_CROSS_SITE_INSECURE') {
          emit(reporters, (r) =>
            r.warn(
              `${relPath}: cookie "${w.name}" from ${w.host} sets SameSite=None without ` +
                `Secure; it was stored, but a browser would reject it.`,
              w
            )
          )
        }
      }

      const unit = toRequestUnit({
        path: relPath,
        resolved,
        result,
        durationMs,
        showSecrets: options.showSecrets ?? false
      })
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
  ctx: { workspace: string; environment: string; startedAt: Date; endedAt: Date }
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
