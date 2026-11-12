import { describe, expect, it } from 'vitest'
import { scripting } from '@fetchpier/core'
import type { ExecutedRequestResult, ScriptExecutionResult } from '@shared/types'
import { toRequestUnit } from './to-unit'

function unitFor(preRequest: ScriptExecutionResult) {
  return toRequestUnit({
    path: 'requests/a.http',
    resolved: { method: 'GET', url: 'https://api.example.com/', headers: {} },
    result: { scriptResults: { preRequest } } as ExecutedRequestResult,
    durationMs: 1,
    showSecrets: false
  })
}

/** The `line` the report gives for a pre-request script that fails. */
function reportedLine(script: string, phase: scripting.ScriptPhase = 'pre-request') {
  const outcome = scripting.runFpScript({
    phase,
    script,
    request: { method: 'GET', url: 'https://api.example.com/', headers: {} },
    response:
      phase === 'post-response'
        ? { status: 200, statusText: 'OK', headers: {}, body: '', timingMs: 1, sizeBytes: 0 }
        : undefined,
    environment: {},
    variables: {}
  })
  expect(outcome.result.success).toBe(false)
  const errors = unitFor(outcome.result).scripts.preRequest?.errors ?? []
  expect(errors).toHaveLength(1)
  return errors[0].line
}

describe('toRequestUnit — the script error line is the line in the script', () => {
  it('a runtime error reports its own line, not the one below it', () => {
    expect(reportedLine('const a = 1\nconst b = 2\nnull.foo')).toBe(3)
    expect(reportedLine('null.foo')).toBe(1)
  })

  it('a number in the error message is not taken for the line', () => {
    expect(reportedLine("const a = 1\nthrow new Error('deadline 12:30:45 passed')")).toBe(2)
  })

  it('a syntax error reports the line V8 points at in the script', () => {
    expect(reportedLine('const a = 1\nconst = 2\nconst c = 3')).toBe(2)
  })

  it('a syntax error V8 places on the sandbox wrapper reports no line', () => {
    expect(reportedLine('const a = 1\nconst b = (\n')).toBeUndefined()
  })

  it('an error thrown by the fp API reports the script line that called it', () => {
    expect(reportedLine('const a = 1\nfp.request.headers.set("X", "Y")', 'post-response')).toBe(2)
  })

  it('a stack with no frame of the sandbox script reports no line', () => {
    const base = { success: false, logs: [], testResults: [] }
    const line = (stack: string | undefined) =>
      unitFor({ ...base, error: { message: 'x', stack } }).scripts.preRequest?.errors[0].line
    expect(line(undefined)).toBeUndefined()
    expect(line('Error: x 1:2:3\n    at new Script (node:vm:117:7)')).toBeUndefined()
  })
})
