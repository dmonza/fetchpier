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

describe('runFpScript — the parts collection follows Array semantics', () => {
  // text a, file b (REF_A), file c (REF_B)
  function runOnThreeParts(script: string, phase: 'pre-request' | 'post-response' = 'pre-request') {
    return runFpScript({
      phase,
      script,
      request: multipartRequest([
        textPart('mp-0', 'a', 'A'),
        filePart('mp-1', 'b', REF_A, 'beach.jpg'),
        filePart('mp-2', 'c', REF_B, 'sunset.jpg')
      ]),
      response:
        phase === 'post-response'
          ? { status: 200, statusText: 'OK', headers: {}, body: '', timingMs: 1, sizeBytes: 0 }
          : undefined,
      environment: {},
      variables: {}
    })
  }
  const sentNames = (outcome: ReturnType<typeof runFpScript>): string[] | undefined =>
    outcome.result.modifiedRequest?.multipartParts?.map((p) => p.name)

  it('splice(start) removes through the end and returns the removed parts as parts', () => {
    const outcome = runOnThreeParts(`
      const removed = fp.request.body.parts.splice(1)
      fp.variables.set('removed', removed.length)
      fp.variables.set('refs', [removed[0].fileRef, removed[1].fileRef])
      fp.variables.set('len', fp.request.body.parts.length)
    `)
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables).toMatchObject({ removed: 2, refs: [REF_A, REF_B], len: 1 })
    expect(sentNames(outcome)).toEqual(['a'])
  })

  it('splice with a negative start, with no arguments and with an explicit count of 0', () => {
    expect(sentNames(runOnThreeParts(`fp.request.body.parts.splice(-1)`))).toEqual(['a', 'b'])
    const none = runOnThreeParts(`
      fp.variables.set('r0', fp.request.body.parts.splice().length)
      fp.variables.set('r1', fp.request.body.parts.splice(0, 0).length)
    `)
    expect(none.variables).toMatchObject({ r0: 0, r1: 0 })
    expect(none.result.modifiedRequest).toBeUndefined()
  })

  it('pop and shift return the removed part as a part, and undefined on an empty list', () => {
    const outcome = runOnThreeParts(`
      const parts = fp.request.body.parts
      fp.variables.set('popped', parts.pop().fileRef)
      fp.variables.set('shifted', parts.shift().value)
      parts.pop()
      fp.variables.set('emptyPop', parts.pop() === undefined)
      fp.variables.set('emptyShift', parts.shift() === undefined)
    `)
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables).toMatchObject({
      popped: REF_B,
      shifted: 'A',
      emptyPop: true,
      emptyShift: true
    })
  })

  it('a sort comparator receives parts, so it can compare by fileRef', () => {
    const outcome = runOnThreeParts(`
      fp.request.body.parts.sort((x, y) => String(y.fileRef || '').localeCompare(String(x.fileRef || '')))
    `)
    expect(outcome.result.success).toBe(true)
    expect(sentNames(outcome)).toEqual(['c', 'b', 'a'])
  })

  it('an index write at length appends; one past it is rejected and leaves no hole', () => {
    const appended = runOnThreeParts(
      `fp.request.body.parts[3] = { kind: 'text', name: 'd', value: 'D' }`
    )
    expect(sentNames(appended)).toEqual(['a', 'b', 'c', 'd'])

    const gap = runOnThreeParts(`
      try { fp.request.body.parts[5] = { kind: 'text', name: 'x', value: 'y' } }
      catch (e) { fp.variables.set('msg', e.message) }
      fp.variables.set('len', fp.request.body.parts.length)
    `)
    expect(gap.variables.msg).toMatch(/parts\[5\].*length 3/)
    expect(gap.variables.len).toBe(3)
    expect(gap.result.modifiedRequest).toBeUndefined()
  })

  it('length can truncate but not grow the list', () => {
    expect(sentNames(runOnThreeParts(`fp.request.body.parts.length = 1`))).toEqual(['a'])
    const grow = runOnThreeParts(`
      try { fp.request.body.parts.length = 6 } catch (e) { fp.variables.set('msg', e.message) }
      fp.request.body.parts.length = 3
      fp.variables.set('len', fp.request.body.parts.length)
    `)
    expect(grow.variables.msg).toMatch(/length.*3/)
    expect(grow.variables.len).toBe(3)
    expect(grow.result.modifiedRequest).toBeUndefined()
  })

  it.each(['pre-request', 'post-response'] as const)(
    'logging the multipart body, its parts and fp.request works in %s',
    (phase) => {
      const outcome = runOnThreeParts(
        `fp.log(fp.request.body); fp.log(fp.request.body.parts); console.log(fp.request)`,
        phase
      )
      expect(outcome.result.success).toBe(true)
      const [body, parts, request] = outcome.result.logs.map((l) => l.args[0]) as [
        { parts: unknown[] },
        unknown[],
        { body: { parts: unknown[] } }
      ]
      expect(parts).toEqual([
        { kind: 'text', name: 'a', value: 'A' },
        { kind: 'file', name: 'b', fileRef: REF_A },
        { kind: 'file', name: 'c', fileRef: REF_B }
      ])
      expect(body.parts).toEqual(parts)
      expect(request.body.parts).toHaveLength(3)
    }
  )
})
