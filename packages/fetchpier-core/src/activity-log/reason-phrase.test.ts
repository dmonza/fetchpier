import { describe, expect, it } from 'vitest'
import { fillReasonPhrase } from './reason-phrase'

describe('fillReasonPhrase', () => {
  it('returns canonical phrases for common status codes', () => {
    expect(fillReasonPhrase(200)).toBe('OK')
    expect(fillReasonPhrase(201)).toBe('Created')
    expect(fillReasonPhrase(204)).toBe('No Content')
    expect(fillReasonPhrase(301)).toBe('Moved Permanently')
    expect(fillReasonPhrase(400)).toBe('Bad Request')
    expect(fillReasonPhrase(401)).toBe('Unauthorized')
    expect(fillReasonPhrase(403)).toBe('Forbidden')
    expect(fillReasonPhrase(404)).toBe('Not Found')
    expect(fillReasonPhrase(409)).toBe('Conflict')
    expect(fillReasonPhrase(429)).toBe('Too Many Requests')
    expect(fillReasonPhrase(500)).toBe('Internal Server Error')
    expect(fillReasonPhrase(502)).toBe('Bad Gateway')
    expect(fillReasonPhrase(503)).toBe('Service Unavailable')
  })

  it('returns empty string for non-standard codes', () => {
    expect(fillReasonPhrase(0)).toBe('')
    expect(fillReasonPhrase(599)).toBe('')
    expect(fillReasonPhrase(999)).toBe('')
  })
})
