// Renders of `historyEntryToActivityLog` that exercise the request body
// section for multipart and binary bodies. The faithful-reflection rule:
// what the writer puts in the `.http` body must match what went on the wire
// (text part values interpolated, file parts shown as `<bytes of …>`
// placeholders, binary uploads acknowledged with the same placeholder
// form).

import { describe, expect, it } from 'vitest'
import { historyEntryToActivityLog } from './history-format'
import type { HistoryEntry, ResolvedRequestSnapshot } from '@shared/types'

function baseEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'aaaa-bbbb-cccc-dddd',
    timestamp: '2026-05-28T18:59:09.484Z',
    sourceFile: 'requests/audio/transcription.http',
    request: {
      method: 'POST',
      url: '{{baseUrl}}/audio/transcriptions',
      headers: {
        Authorization: 'Bearer {{apiKey}}',
        Accept: 'application/json'
      },
      ...overrides.request
    },
    response: overrides.response ?? {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
      body: '{"text":"hello"}',
      timingMs: 100,
      sizeBytes: 20
    },
    ...overrides
  }
}

describe('historyEntryToActivityLog — request body faithfulness', () => {
  it('multipart: renders snapshot text values (resolved) and file placeholder using the wire boundary', () => {
    const BOUNDARY = '----FetchpierBoundary12345'
    const wireRequest: ResolvedRequestSnapshot = {
      method: 'POST',
      url: 'https://api.openai.com/audio/transcriptions',
      headers: {
        Authorization: 'Bearer sk-real-key',
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`
      },
      body: undefined,
      multipartParts: [
        {
          kind: 'text',
          name: 'model',
          disabled: false,
          contentType: undefined,
          value: 'whisper-1'
        },
        {
          kind: 'file',
          name: 'file',
          disabled: false,
          contentType: 'audio/mpeg',
          fileRef: 'sha256abc__audio.mp3',
          filename: 'audio.mp3',
          sizeBytes: 12_345
        }
      ]
    }
    const entry: HistoryEntry = {
      ...baseEntry({
        request: {
          method: 'POST',
          url: '{{baseUrl}}/audio/transcriptions',
          headers: { Authorization: 'Bearer {{apiKey}}' },
          bodyType: 'multipart-form'
        }
      }),
      wireRequest
    }
    const file = historyEntryToActivityLog(entry)
    // Request line + headers come from the wire (resolved URL, Content-Type+boundary).
    // The Authorization value is redacted on disk; scheme is preserved.
    expect(file.requestRaw).toContain('POST https://api.openai.com/audio/transcriptions HTTP/1.1')
    expect(file.requestRaw).toContain('Authorization: Bearer <redacted>')
    expect(file.requestRaw).not.toContain('sk-real-key')
    expect(file.requestRaw).toContain(`Content-Type: multipart/form-data; boundary=${BOUNDARY}`)
    // Body uses the boundary value and the resolved text part value.
    expect(file.requestRaw).toContain(`--${BOUNDARY}`)
    expect(file.requestRaw).toContain('Content-Disposition: form-data; name="model"')
    expect(file.requestRaw).toContain('whisper-1')
    expect(file.requestRaw).not.toContain('{{')
    // File part shows the placeholder, including ref and human-readable size.
    expect(file.requestRaw).toContain(
      'Content-Disposition: form-data; name="file"; filename="audio.mp3"'
    )
    expect(file.requestRaw).toContain('Content-Type: audio/mpeg')
    expect(file.requestRaw).toContain('<bytes of sha256abc__audio.mp3 — 12.1 KB>')
    expect(file.requestRaw.trimEnd().endsWith(`--${BOUNDARY}--`)).toBe(true)
  })

  it('multipart: skips disabled parts coming through the snapshot', () => {
    const entry: HistoryEntry = {
      ...baseEntry({
        request: { method: 'POST', url: 'x', headers: {}, bodyType: 'multipart-form' }
      }),
      wireRequest: {
        method: 'POST',
        url: 'x',
        headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
        body: undefined,
        multipartParts: [
          { kind: 'text', name: 'keep', disabled: false, value: 'yes' },
          { kind: 'text', name: 'skip', disabled: true, value: 'no' }
        ]
      }
    }
    const file = historyEntryToActivityLog(entry)
    expect(file.requestRaw).toContain('name="keep"')
    expect(file.requestRaw).not.toContain('name="skip"')
  })

  it('multipart legacy fallback: no wire snapshot still renders from editor-side parts', () => {
    const entry: HistoryEntry = baseEntry({
      request: {
        method: 'POST',
        url: 'https://x.test/u',
        headers: { 'Content-Type': 'multipart/form-data; boundary=L' },
        bodyType: 'multipart-form',
        multipartParts: [
          {
            kind: 'text',
            id: 'p1',
            name: 'legacy',
            value: 'literal-text'
          }
        ]
      }
    })
    const file = historyEntryToActivityLog(entry)
    expect(file.requestRaw).toContain('--L')
    expect(file.requestRaw).toContain('name="legacy"')
    expect(file.requestRaw).toContain('literal-text')
  })

  it('binary: renders <bytes of …> placeholder for raw binary uploads', () => {
    const entry: HistoryEntry = baseEntry({
      request: {
        method: 'POST',
        url: 'https://x.test/upload',
        headers: { 'Content-Type': 'image/png' },
        bodyType: 'binary',
        binaryFile: {
          ref: 'sha256xyz__photo.png',
          originalName: 'photo.png',
          sizeBytes: 1_572_864,
          mimeType: 'image/png'
        }
      }
    })
    const file = historyEntryToActivityLog(entry)
    expect(file.requestRaw).toContain('<bytes of sha256xyz__photo.png — 1.5 MB>')
  })

  it('binary without binaryFile (defensive): no crash, empty body section', () => {
    const entry: HistoryEntry = baseEntry({
      request: {
        method: 'POST',
        url: 'https://x.test/upload',
        headers: { 'Content-Type': 'image/png' },
        bodyType: 'binary'
      }
    })
    const file = historyEntryToActivityLog(entry)
    // No body content — request section ends with the headers and the blank.
    expect(file.requestRaw).not.toContain('<bytes of')
  })

  it('redacts the Authorization header value while keeping the scheme', () => {
    const entry: HistoryEntry = baseEntry({
      request: {
        method: 'GET',
        url: 'https://x.test/me',
        headers: {}
      },
      wireRequest: {
        method: 'GET',
        url: 'https://x.test/me',
        headers: {
          Authorization: 'Bearer sk-supersecret-XYZ',
          Accept: 'application/json'
        }
      }
    })
    const file = historyEntryToActivityLog(entry)
    expect(file.requestRaw).toContain('Authorization: Bearer <redacted>')
    expect(file.requestRaw).not.toContain('sk-supersecret-XYZ')
    // Other headers untouched
    expect(file.requestRaw).toContain('Accept: application/json')
  })

  it('redacts Authorization without a scheme prefix', () => {
    const entry: HistoryEntry = baseEntry({
      request: { method: 'GET', url: 'x', headers: {} },
      wireRequest: {
        method: 'GET',
        url: 'x',
        headers: { Authorization: 'raw-token-no-scheme' }
      }
    })
    const file = historyEntryToActivityLog(entry)
    expect(file.requestRaw).toContain('Authorization: <redacted>')
    expect(file.requestRaw).not.toContain('raw-token-no-scheme')
  })

  it('redacts Authorization regardless of header-name casing', () => {
    const entry: HistoryEntry = baseEntry({
      request: { method: 'GET', url: 'x', headers: {} },
      wireRequest: {
        method: 'GET',
        url: 'x',
        headers: { authorization: 'Basic dXNlcjpwYXNz' }
      }
    })
    const file = historyEntryToActivityLog(entry)
    expect(file.requestRaw).toContain('authorization: Basic <redacted>')
    expect(file.requestRaw).not.toContain('dXNlcjpwYXNz')
  })

  it('plain JSON request: still flows through wire.body when present', () => {
    const entry: HistoryEntry = baseEntry({
      request: {
        method: 'POST',
        url: '{{baseUrl}}/x',
        headers: { 'Content-Type': 'application/json' },
        bodyType: 'raw',
        body: '{"name":"{{who}}"}'
      },
      wireRequest: {
        method: 'POST',
        url: 'https://api.test/x',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"world"}'
      }
    })
    const file = historyEntryToActivityLog(entry)
    expect(file.requestRaw).toContain('POST https://api.test/x HTTP/1.1')
    expect(file.requestRaw).toContain('{"name":"world"}')
    expect(file.requestRaw).not.toContain('{{who}}')
  })
})

describe('historyEntryToActivityLog — decoded compressed responses (CLI hardening)', () => {
  const compressed = (decodingStatus?: 'decoded' | 'unsupported') =>
    baseEntry({
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: '{"items":[1,2,3]}',
        timingMs: 1,
        sizeBytes: 17,
        ...(decodingStatus ? { decodingStatus } : {})
      }
    })

  it('records a decoded gzip JSON response as its text', () => {
    const file = historyEntryToActivityLog(compressed('decoded'))
    expect(file.responseRaw).toContain('{"items":[1,2,3]}')
    expect(file.responseRaw).not.toContain('[binary body')
    // The header is kept as received.
    expect(file.responseRaw).toMatch(/Content-Encoding: gzip/i)
  })

  it('still records an undecoded (or pre-decoding) compressed body as a binary placeholder', () => {
    expect(historyEntryToActivityLog(compressed('unsupported')).responseRaw).toContain(
      '[binary body'
    )
    expect(historyEntryToActivityLog(compressed()).responseRaw).toContain('[binary body')
  })
})
