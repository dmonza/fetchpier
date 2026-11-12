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

  // CA-16 (response echoes masked by substring) lives in `requests/execute`: the
  // engine masks the response with the same value set as script output
  // (`createValueMask`, which also owns the empty-value rule).

  // ENG-22: a pre-request script's write to a referenced secret is used on the
  // same send, through per-send overrides that keep the nonce and the log mask.
  describe('withOverrides', () => {
    it('renders the overridden plaintext on the wire and keeps the log mask', () => {
      const m = make()
      const o = m.withOverrides({ apiToken: 'NEW' }, [])
      const text = `Bearer ${m.markerVariables.apiToken}`
      expect(o.markerVariables.apiToken).toBe(m.markerVariables.apiToken)
      expect(o.wireRender(text)).toBe('Bearer NEW')
      expect(o.logRender(text)).toBe('Bearer {secret:apiToken}')
      expect(o.scriptEnvironment.apiToken).toBe('NEW')
      expect(o.collectMaskedNames([text])).toEqual(['apiToken'])
      // The original masker is unchanged.
      expect(m.wireRender(text)).toBe('Bearer SEKRET')
    })

    it('drops a removed name so its marker is neither seeded nor rendered', () => {
      const m = make()
      const o = m.withOverrides({}, ['apiToken'])
      expect(o.markerVariables).not.toHaveProperty('apiToken')
      expect(o.scriptEnvironment).not.toHaveProperty('apiToken')
      const text = `Bearer ${m.markerVariables.apiToken}`
      expect(o.wireRender(text)).toBe(text)
    })

    it('ignores names the masker does not hold', () => {
      const m = make()
      const o = m.withOverrides({ unrelated: 'x' }, ['other'])
      expect(Object.keys(o.markerVariables).sort()).toEqual(['apiToken', 'empty'])
    })
  })

  it('collectMaskedNames reports only names whose marker appears', () => {
    const m = make()
    const withApiToken = m.markerVariables.apiToken
    expect(m.collectMaskedNames([`x ${withApiToken}`, undefined])).toEqual(['apiToken'])
    expect(m.collectMaskedNames(['nothing here'])).toEqual([])
  })
})
