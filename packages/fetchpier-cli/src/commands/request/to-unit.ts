import type {
  ExecutedRequestResult,
  ScriptExecutionResult,
  ScriptLog as CoreScriptLog
} from '@shared/types'
import type { RequestUnit, ScriptError, ScriptLog, ScriptMutationSummary } from '../../types'
import { redactHeaders } from '../../output/formatters'

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

/** Best-effort extraction of a line number from a sandbox stack trace. */
function lineFromStack(stack?: string): number | undefined {
  if (!stack) return undefined
  const m = stack.match(/<anonymous>:(\d+):\d+/) ?? stack.match(/:(\d+):\d+\)?/)
  return m ? Number(m[1]) : undefined
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
}): RequestUnit {
  const { path, resolved, result, durationMs, showSecrets } = args

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
  const reqUrl = snapshot?.url ?? resolved.url
  const reqHeaders = snapshot?.headers ?? resolved.headers
  const reqBody = snapshot?.body ?? resolved.body

  return {
    type: 'request',
    path,
    name: `${reqMethod} ${reqUrl}`,
    request: {
      method: reqMethod,
      url: reqUrl,
      headers: redactHeaders(reqHeaders, showSecrets),
      ...(reqBody !== undefined ? { body: reqBody } : {})
    },
    response: result.response
      ? {
          status: result.response.status,
          statusText: result.response.statusText,
          headers: redactHeaders(result.response.headers, showSecrets),
          body: result.response.body,
          timingMs: result.response.timingMs,
          sizeBytes: result.response.sizeBytes
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
    durationMs
  }
}
