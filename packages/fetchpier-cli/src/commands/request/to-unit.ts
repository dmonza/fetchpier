import type {
  ExecutedRequestResult,
  ScriptExecutionResult,
  ScriptLog as CoreScriptLog
} from '@shared/types'
import type {
  RequestUnit,
  ScriptError,
  ScriptLog,
  ScriptMutationSummary,
  UnitFindings
} from '../../types'
import { scripting } from '@fetchpier/core'
import { redactHeaders, redactUrl, type ApiKeyCredential } from '../../output/formatters'
import { findingMessage } from '../../output/findings-messages'

/** The engine's evaluation as reported, with each rule's English title. */
function mapFindings(f: ExecutedRequestResult['findings']): UnitFindings | undefined {
  if (!f) return undefined
  if (f.status === 'failed') return { evaluationFailed: true }
  return {
    rulesApplied: f.rulesApplied,
    tls: f.tls,
    finalOrigin: f.finalOrigin,
    items: f.items.map((i) => ({ ...i, title: findingMessage(i.ruleId).title }))
  }
}

export interface ResolvedRequestView {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

/** Render a script log's args into a single human-readable message string. */
function argsToMessage(args: unknown[]): { message: string; redacted: boolean } {
  let redacted = false
  const parts = args.map((a) => {
    if (typeof a === 'string') return a
    if (a && typeof a === 'object' && '__inspect' in a) {
      redacted = true
      return `[${(a as { __inspect: string }).__inspect}]`
    }
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  })
  return { message: parts.join(' '), redacted }
}

function mapLogs(logs: CoreScriptLog[]): ScriptLog[] {
  return logs.map((l) => {
    const { message, redacted } = argsToMessage(l.args)
    return { level: l.level, message, ...(redacted ? { argsRedacted: true } : {}) }
  })
}

/** The file name the sandbox gives the wrapped script (`fp-<phase>-script.js`). */
const SCRIPT_FILE = String.raw`fp-(?:pre-request|post-response)-script\.js`
// `displayErrors` header: `<file>:N`, then the source line, on the first lines.
const HEADER_RE = new RegExp(String.raw`^${SCRIPT_FILE}:(\d+)\r?\n([^\r\n]*)`)
// Innermost stack frame in the script itself (host frames come before it when
// an `fp` API call threw).
const FRAME_RE = new RegExp(String.raw`^\s+at (?:.*\()?${SCRIPT_FILE}:(\d+):\d+\)?$`, 'm')

/**
 * The line in the user's script that a sandbox error points at, or undefined.
 * Only the sandbox's own file counts (never a host frame or a number in the
 * message), and the wrapper's header offset is taken off. A syntax error V8
 * places on the wrapper's closing line has no line in the script.
 */
function lineFromStack(stack?: string): number | undefined {
  if (!stack) return undefined
  const header = stack.match(HEADER_RE)
  let wrapped: number
  if (header) {
    if (header[2] === scripting.SCRIPT_WRAPPER_FOOTER) return undefined
    wrapped = Number(header[1])
  } else {
    const frame = stack.match(FRAME_RE)
    if (!frame) return undefined
    wrapped = Number(frame[1])
  }
  const line = wrapped - scripting.SCRIPT_WRAPPER_HEADER_LINES
  return line >= 1 ? line : undefined
}

function mapErrors(section: ScriptExecutionResult): ScriptError[] {
  if (section.success || !section.error) return []
  return [
    {
      message: section.error.message,
      stack: section.error.stack,
      ...(lineFromStack(section.error.stack) != null
        ? { line: lineFromStack(section.error.stack) }
        : {})
    }
  ]
}

function mapMutations(section: ScriptExecutionResult): ScriptMutationSummary | undefined {
  const headersModified = section.modifiedRequest?.headers
    ? Object.keys(section.modifiedRequest.headers).length
    : 0
  const variablesSet = section.environmentChanges?.set
    ? Object.keys(section.environmentChanges.set).length
    : 0
  const environmentChanged = variablesSet + (section.environmentChanges?.removed?.length ?? 0)
  if (headersModified === 0 && variablesSet === 0 && environmentChanged === 0) return undefined
  return { headersModified, variablesSet, environmentChanged }
}

function mapSection(
  section: ScriptExecutionResult | undefined
): { logs: ScriptLog[]; errors: ScriptError[]; mutations?: ScriptMutationSummary } | undefined {
  if (!section) return undefined
  const mutations = mapMutations(section)
  return {
    logs: mapLogs(section.logs),
    errors: mapErrors(section),
    ...(mutations ? { mutations } : {})
  }
}

/**
 * Transform a single executed request into the structured {@link RequestUnit}
 * the reporters consume. `resolved` carries the post-resolution request fields
 * for display (the response itself does not echo the final URL).
 */
export function toRequestUnit(args: {
  path: string
  resolved: ResolvedRequestView
  result: ExecutedRequestResult
  durationMs: number
  showSecrets: boolean
  /** The request's API-key auth credential, redacted in every report unless `showSecrets`. */
  apiKey?: ApiKeyCredential
}): RequestUnit {
  const { path, resolved, result, durationMs, showSecrets, apiKey } = args

  const pre = mapSection(result.scriptResults?.preRequest)
  const post = mapSection(result.scriptResults?.postResponse)

  const tests = [
    ...(result.scriptResults?.preRequest?.testResults ?? []),
    ...(result.scriptResults?.postResponse?.testResults ?? [])
  ].map((t) => ({ name: t.name, passed: t.passed, ...(t.error ? { error: t.error } : {}) }))

  // Prefer the snapshot captured by `requests.execute` when present: it carries
  // the real multipart Content-Type (with the generated boundary) and the
  // parts summary that the resolveForDisplay view cannot reconstruct.
  // Fall back to `resolved` for cases where execute aborted before sending
  // (script failure) or when running an older core version that does not yet
  // populate `request`.
  const snapshot = result.request
  const reqMethod = snapshot?.method ?? resolved.method
  // Redaction happens here, upstream of every reporter, so the terminal and the
  // JSON / JUnit / HTML reports can never disagree about what they hide.
  const reqUrl = redactUrl(snapshot?.url ?? resolved.url, apiKey, showSecrets)
  const reqHeaders = snapshot?.headers ?? resolved.headers
  const reqBody = snapshot?.body ?? resolved.body
  // The response is masked unless `--show-secrets`, which shows it as received.
  // The history never reads this: it records `result.response`, always masked.
  const response = (showSecrets ? result.unmaskedResponse : undefined) ?? result.response
  // Present only when the run asked for findings and the request got a response.
  const findings = result.response ? mapFindings(result.findings) : undefined

  return {
    type: 'request',
    path,
    name: `${reqMethod} ${reqUrl}`,
    request: {
      method: reqMethod,
      url: reqUrl,
      headers: redactHeaders(reqHeaders, showSecrets, apiKey),
      ...(reqBody !== undefined ? { body: reqBody } : {})
    },
    response: response
      ? {
          status: response.status,
          statusText: response.statusText,
          headers: redactHeaders(response.headers, showSecrets),
          body: response.body,
          timingMs: response.timingMs,
          sizeBytes: response.sizeBytes,
          ...(response.compressedBytes !== undefined
            ? { compressedBytes: response.compressedBytes }
            : {}),
          ...(response.decompressedBytes !== undefined
            ? { decompressedBytes: response.decompressedBytes }
            : {}),
          ...(response.decodingStatus ? { decodingStatus: response.decodingStatus } : {}),
          ...(response.binaryHint ? { binaryHint: true as const } : {})
        }
      : undefined,
    scripts: {
      ...(pre ? { preRequest: pre } : {}),
      ...(post ? { postResponse: post } : {})
    },
    tests,
    // Only meaningful when nothing came back: a unit with a response is not a
    // failure to send, whatever else went wrong with it.
    ...(!result.response && result.error ? { error: result.error } : {}),
    ...(!result.response && result.notSent ? { notRun: true as const } : {}),
    ...(findings ? { findings } : {}),
    durationMs
  }
}
