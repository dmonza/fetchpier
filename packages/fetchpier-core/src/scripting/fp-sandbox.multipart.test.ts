import { describe, expect, it } from 'vitest'
import { runFpScript } from './fp-sandbox'
import type { HttpRequest, MultipartPart } from '@shared/types'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const REF_A = `${HASH_A}__beach.jpg`
const REF_B = `${HASH_B}__sunset.jpg`

function textPart(
  id: string,
  name: string,
  value: string,
  extra: Partial<MultipartPart> = {}
): MultipartPart {
  return { kind: 'text', id, name, value, ...extra } as MultipartPart
}

function filePart(id: string, name: string, ref: string, originalName: string): MultipartPart {
  return {
    kind: 'file',
    id,
    name,
    file: { ref, originalName, sizeBytes: 0, mimeType: 'image/jpeg' }
  }
}

function multipartRequest(parts: MultipartPart[]): HttpRequest {
  return {
    method: 'POST',
    url: 'https://example.com/upload',
    headers: {},
    bodyType: 'multipart-form',
    multipartParts: parts
  }
}

describe('runFpScript — multipart body surface (REQ-0066)', () => {
  it('exposes a structured body with a parts array on pre-request', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.variables.set('bodyType', fp.request.bodyType)
        fp.variables.set('len', fp.request.body.parts.length)
        fp.variables.set('name0', fp.request.body.parts[0].name)
        fp.variables.set('value0', fp.request.body.parts[0].value)
        fp.variables.set('kind1', fp.request.body.parts[1].kind)
        fp.variables.set('fileRef1', fp.request.body.parts[1].fileRef)
      `,
      request: multipartRequest([
        textPart('mp-0', 'description', 'hello'),
        filePart('mp-1', 'file', REF_A, 'beach.jpg')
      ]),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables.bodyType).toBe('multipart-form')
    expect(outcome.variables.len).toBe(2)
    expect(outcome.variables.name0).toBe('description')
    expect(outcome.variables.value0).toBe('hello')
    expect(outcome.variables.kind1).toBe('file')
    expect(outcome.variables.fileRef1).toBe(REF_A)
  })

  it('CA-05: pre-request script adds a part via push (text part)', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.request.body.parts.push({ kind: 'text', name: 'csrf', value: 'tok' })
      `,
      request: multipartRequest([textPart('mp-0', 'a', 'A')]),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.modifiedRequest?.multipartParts).toBeDefined()
    const parts = outcome.result.modifiedRequest!.multipartParts!
    expect(parts).toHaveLength(2)
    expect(parts[1]).toMatchObject({ kind: 'text', name: 'csrf', value: 'tok' })
  })

  it('script adds a file part by reference to an already-staged file', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.request.body.parts.push({
          kind: 'file',
          name: 'thumbnail',
          fileRef: ${JSON.stringify(REF_B)},
          filename: 'thumb.jpg',
          contentType: 'image/jpeg'
        })
      `,
      request: multipartRequest([textPart('mp-0', 'a', 'A')]),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    const parts = outcome.result.modifiedRequest!.multipartParts!
    expect(parts).toHaveLength(2)
    expect(parts[1].kind).toBe('file')
    if (parts[1].kind === 'file') {
      expect(parts[1].file.ref).toBe(REF_B)
      expect(parts[1].filename).toBe('thumb.jpg')
      expect(parts[1].contentType).toBe('image/jpeg')
    }
  })

  it('CA-06: pushing a file part with bytes throws TypeError', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        try {
          fp.request.body.parts.push({ kind: 'file', name: 'x', bytes: new Uint8Array([1,2,3]) })
          fp.variables.set('threw', false)
        } catch (e) {
          fp.variables.set('threw', true)
          fp.variables.set('msg', String(e))
        }
      `,
      request: multipartRequest([]),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables.threw).toBe(true)
    expect(String(outcome.variables.msg)).toMatch(/TypeError|unknown field|may only reference/)
  })

  it('pushing a file part with malformed fileRef throws TypeError', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        try {
          fp.request.body.parts.push({ kind: 'file', name: 'x', fileRef: 'not-a-ref' })
          fp.variables.set('threw', false)
        } catch (e) {
          fp.variables.set('threw', true)
          fp.variables.set('msg', String(e))
        }
      `,
      request: multipartRequest([]),
      environment: {},
      variables: {}
    })
    expect(outcome.variables.threw).toBe(true)
    expect(String(outcome.variables.msg)).toMatch(/64-hex|already-staged/)
  })

  it('part.fileRef is read-only — assignment throws (existing file part)', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        try {
          fp.request.body.parts[0].fileRef = 'something-else'
          fp.variables.set('threw', false)
        } catch (e) {
          fp.variables.set('threw', true)
        }
      `,
      request: multipartRequest([filePart('mp-0', 'photo', REF_A, 'beach.jpg')]),
      environment: {},
      variables: {}
    })
    expect(outcome.variables.threw).toBe(true)
  })

  it('mutating part.value flows through to modifiedRequest.multipartParts', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.request.body.parts[0].value = 'replaced'
      `,
      request: multipartRequest([textPart('mp-0', 'a', 'original')]),
      environment: {},
      variables: {}
    })
    expect(outcome.result.modifiedRequest?.multipartParts).toBeDefined()
    expect(outcome.result.modifiedRequest!.multipartParts![0]).toMatchObject({
      kind: 'text',
      name: 'a',
      value: 'replaced'
    })
  })

  it('toggling part.disabled flows through (CA-12 enabling/disabling at send time)', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.request.body.parts[0].disabled = true
      `,
      request: multipartRequest([textPart('mp-0', 'a', 'A')]),
      environment: {},
      variables: {}
    })
    expect(outcome.result.modifiedRequest?.multipartParts).toBeDefined()
    expect(outcome.result.modifiedRequest!.multipartParts![0].disabled).toBe(true)
  })

  it('splice removes and inserts parts via diff-and-apply', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.request.body.parts.splice(1, 1, { kind: 'text', name: 'inserted', value: 'I' })
      `,
      request: multipartRequest([
        textPart('mp-0', 'a', 'A'),
        textPart('mp-1', 'remove-me', 'X'),
        textPart('mp-2', 'b', 'B')
      ]),
      environment: {},
      variables: {}
    })
    const parts = outcome.result.modifiedRequest!.multipartParts!
    expect(parts.map((p) => p.name)).toEqual(['a', 'inserted', 'b'])
  })

  it('does NOT emit modifiedRequest.multipartParts when no mutation happened', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        // Read-only access
        fp.variables.set('count', fp.request.body.parts.length)
      `,
      request: multipartRequest([textPart('mp-0', 'a', 'A')]),
      environment: {},
      variables: {}
    })
    expect(outcome.result.modifiedRequest?.multipartParts).toBeUndefined()
  })

  it('CA-07: post-response script cannot mutate parts (push throws)', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `
        try {
          fp.request.body.parts.push({ kind: 'text', name: 'x', value: 'y' })
          fp.variables.set('threw', false)
        } catch (e) {
          fp.variables.set('threw', true)
        }
      `,
      request: multipartRequest([textPart('mp-0', 'a', 'A')]),
      response: { status: 200, statusText: 'OK', headers: {}, body: '', timingMs: 1, sizeBytes: 0 },
      environment: {},
      variables: {}
    })
    expect(outcome.variables.threw).toBe(true)
  })

  it('CA-07: post-response script cannot mutate part.value', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `
        try {
          fp.request.body.parts[0].value = 'tampered'
          fp.variables.set('threw', false)
        } catch (e) {
          fp.variables.set('threw', true)
        }
      `,
      request: multipartRequest([textPart('mp-0', 'a', 'A')]),
      response: { status: 200, statusText: 'OK', headers: {}, body: '', timingMs: 1, sizeBytes: 0 },
      environment: {},
      variables: {}
    })
    expect(outcome.variables.threw).toBe(true)
  })

  it('writing to fp.request.body directly throws (mutate via parts)', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        try {
          fp.request.body = 'plain string'
          fp.variables.set('threw', false)
        } catch (e) {
          fp.variables.set('threw', true)
        }
      `,
      request: multipartRequest([]),
      environment: {},
      variables: {}
    })
    expect(outcome.variables.threw).toBe(true)
  })
})
