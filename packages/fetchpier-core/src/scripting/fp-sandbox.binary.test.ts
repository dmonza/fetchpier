import { describe, expect, it } from 'vitest'
import { runFpScript } from './fp-sandbox'
import type { HttpRequest } from '@shared/types'

const VALID_HASH = 'a'.repeat(64)
const VALID_REF = `${VALID_HASH}__report.pdf`

function binaryRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'POST',
    url: 'https://example.com/upload',
    headers: { 'Content-Type': 'application/pdf' },
    body: undefined,
    bodyType: 'binary',
    binaryFile: {
      ref: VALID_REF,
      originalName: 'report.pdf',
      sizeBytes: 1234,
      mimeType: 'application/pdf'
    },
    ...overrides
  }
}

describe('runFpScript — binary body semantics', () => {
  it('exposes fp.request.bodyType and binaryFileRef in pre-request', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.variables.set("bodyType", fp.request.bodyType);
        fp.variables.set("ref", fp.request.binaryFileRef);
        fp.variables.set("body", fp.request.body);
      `,
      request: binaryRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables.bodyType).toBe('binary')
    expect(outcome.variables.ref).toBe(VALID_REF)
    expect(outcome.variables.body).toBeUndefined()
  })

  it('exposes the same fields in post-response', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `
        fp.variables.set("bodyType", fp.request.bodyType);
        fp.variables.set("ref", fp.request.binaryFileRef);
        fp.variables.set("body", fp.request.body);
      `,
      request: binaryRequest(),
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: 'OK',
        timingMs: 1,
        sizeBytes: 2
      },
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables.bodyType).toBe('binary')
    expect(outcome.variables.ref).toBe(VALID_REF)
    expect(outcome.variables.body).toBeUndefined()
  })

  it('throws when assigning to fp.request.body in pre-request on a binary request', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.request.body = "hijack";`,
      request: binaryRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message ?? '').toMatch(/binary/i)
  })

  it('throws when assigning to fp.request.bodyType', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.request.bodyType = "raw";`,
      request: binaryRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message ?? '').toMatch(/bodyType is read-only/i)
  })

  it('throws when assigning to fp.request.binaryFileRef', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.request.binaryFileRef = "anything";`,
      request: binaryRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message ?? '').toMatch(/binaryFileRef is read-only/i)
  })

  it('binaryFileRef is undefined for non-binary requests', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.variables.set("ref", fp.request.binaryFileRef);`,
      request: {
        method: 'POST',
        url: 'https://example.com/x',
        headers: {},
        body: '{}',
        bodyType: 'raw'
      },
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables.ref).toBeUndefined()
  })
})
