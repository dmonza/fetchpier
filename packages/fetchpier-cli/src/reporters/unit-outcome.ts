import type { RequestUnit } from '../types'

/**
 * Whether a response-less unit never attempted a send. The engine says so
 * (`RequestUnit.notRun`, from its `notSent`): a failed pre-request script, a
 * multipart part or binary file that could not be read. A file holding no
 * request (no method) is not run either. Everything else without a response —
 * unreachable host, TLS failure, timeout, proxy failure, interrupt in flight —
 * was attempted and is labelled "no response". Decided here, once, so every
 * reporter labels a unit the same way.
 */
export function notRun(unit: RequestUnit): boolean {
  if (unit.response) return false
  if (unit.notRun || unit.request.method === '') return true
  // Units built by an older engine carry no flag; a failed pre-request script
  // still means nothing was sent.
  return (unit.scripts.preRequest?.errors.length ?? 0) > 0
}

/** `not run` or `no response` — the label a response-less unit carries in every report. */
export function responselessLabel(unit: RequestUnit): 'not run' | 'no response' {
  return notRun(unit) ? 'not run' : 'no response'
}
