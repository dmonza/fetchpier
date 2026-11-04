import type { RequestUnit } from '../types'

/**
 * Whether a response-less unit never attempted a send: a file that holds no
 * request (it has no method) or a pre-request script that aborted. Everything
 * else without a response — unreachable host, TLS failure, timeout, proxy
 * failure, interrupt in flight — was attempted and is labelled "no response".
 * Derived here, once, so every reporter labels a unit the same way without the
 * JSON contract growing a field.
 */
export function notRun(unit: RequestUnit): boolean {
  if (unit.response) return false
  if (unit.request.method === '') return true
  return (unit.scripts.preRequest?.errors.length ?? 0) > 0
}

/** `not run` or `no response` — the label a response-less unit carries in every report. */
export function responselessLabel(unit: RequestUnit): 'not run' | 'no response' {
  return notRun(unit) ? 'not run' : 'no response'
}
