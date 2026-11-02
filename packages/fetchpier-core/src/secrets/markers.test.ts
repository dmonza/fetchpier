import { describe, expect, it } from 'vitest'
import { createSecretMasker, mintExecutionNonce, secretMarker } from './markers'

describe('mintExecutionNonce', () => {
  it('is 8 hex chars and unpredictable', () => {
    const a = mintExecutionNonce()
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(mintExecutionNonce()).not.toBe(a)
  })
})

describe('createSecretMasker', () => {
  const nonce = 'cafe1234'
  const make = (): ReturnType<typeof createSecretMasker> =>
    createSecretMasker({ nonce, plaintextByName: { apiToken: 'SEKRET', empty: '' } })

  it('exposes markerVariables and a plaintext scriptEnvironment', () => {
    const m = make()
    expect(m.markerVariables.apiToken).toBe(secretMarker('apiToken', nonce))
    expect(m.scriptEnvironment.apiToken).toBe('SEKRET')
  })

  it('wireRender replaces this execution markers with plaintext', () => {
    const m = make()
    const text = `Bearer ${m.markerVariables.apiToken}`
    expect(m.wireRender(text)).toBe('Bearer SEKRET')
  })

  // CA-15: marker-shaped text with a different nonce is inert on the wire.
  it('wireRender leaves foreign-nonce markers untouched', () => {
    const m = make()
    const foreign = '{$secret:apiToken:deadbeef}'
    expect(m.wireRender(foreign)).toBe(foreign)
  })

  it('logRender replaces this execution markers with the named mask', () => {
    const m = make()
    const text = `Bearer ${m.markerVariables.apiToken}`
    expect(m.logRender(text)).toBe('Bearer {secret:apiToken}')
  })

  it('logRender leaves foreign-nonce markers untouched', () => {
    const m = make()
    const foreign = '{$secret:apiToken:deadbeef}'
    expect(m.logRender(foreign)).toBe(foreign)
  })

  // CA-16: response echoes are masked by substring (best-effort net).
  it('maskResponse masks decrypted values echoed in a response', () => {
    const m = make()
    expect(m.maskResponse('the token is SEKRET here')).toBe('the token is {secret:apiToken} here')
  })

  it('maskResponse never masks on an empty value', () => {
    const m = make()
    // `empty` has value '' — masking on it would corrupt every character.
    expect(m.maskResponse('abc')).toBe('abc')
  })

  it('collectMaskedNames reports only names whose marker appears', () => {
    const m = make()
    const withApiToken = m.markerVariables.apiToken
    expect(m.collectMaskedNames([`x ${withApiToken}`, undefined])).toEqual(['apiToken'])
    expect(m.collectMaskedNames(['nothing here'])).toEqual([])
  })
})
