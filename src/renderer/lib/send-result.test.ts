import { describe, expect, it } from 'vitest'
import { buildHistoryEntry, viewerResponse } from './send-result'
import type { ExecutedRequestResult, HttpRequest, HttpResponse } from '../../shared/types'

const masked: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'x-session': '{secret:token}' },
  body: '{"token":"{secret:token}"}',
  timingMs: 3,
  sizeBytes: 26
}
const asReceived: HttpResponse = {
  ...masked,
  headers: { 'x-session': 'plaintext-jwt' },
  body: '{"token":"plaintext-jwt"}'
}
const request: HttpRequest = { method: 'POST', url: '{{baseUrl}}/login', headers: {} }

describe('viewerResponse', () => {
  it('shows the response as received when the send returned it', () => {
    expect(viewerResponse({ response: masked, unmaskedResponse: asReceived })).toBe(asReceived)
  })

  it('shows the masked response otherwise', () => {
    expect(viewerResponse({ response: masked })).toBe(masked)
  })

  it('has nothing to show for a send with no response', () => {
    expect(viewerResponse({ error: 'no response: refused' })).toBeUndefined()
  })
})

describe('buildHistoryEntry', () => {
  const base = {
    id: 'h-1',
    timestamp: '2026-11-06T10:00:00.000Z',
    request,
    sourceFile: 'auth/login.http',
    requestId: 'req-1'
  }

  it('records the masked response even when the viewer shows it as received', () => {
    const result: ExecutedRequestResult = {
      response: masked,
      unmaskedResponse: asReceived,
      scriptResults: {},
      cookies: { sent: [], received: [] },
      remoteIp: '127.0.0.1'
    }
    const entry = buildHistoryEntry({ ...base, result })
    expect(entry?.response).toBe(masked)
    expect(JSON.stringify(entry)).not.toContain('plaintext-jwt')
    expect(entry).toMatchObject({
      id: 'h-1',
      timestamp: base.timestamp,
      request,
      sourceFile: 'auth/login.http',
      requestId: 'req-1',
      remoteIp: '127.0.0.1'
    })
  })

  it('records nothing for a send with no response', () => {
    expect(
      buildHistoryEntry({ ...base, result: { error: 'not run: script failed' } })
    ).toBeUndefined()
  })
})
