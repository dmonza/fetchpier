import { describe, expect, it } from 'vitest'
import {
  buildManifest,
  parseManifest,
  serializeManifest,
  verifyKeyAgainstChallenge,
  MANIFEST_VERSION
} from './manifest'
import { deriveKeyId, generateWorkspaceKey } from './index'

describe('manifest', () => {
  it('builds a manifest whose challenge verifies with the right key', async () => {
    const key = await generateWorkspaceKey()
    const manifest = await buildManifest(key)
    expect(manifest.version).toBe(MANIFEST_VERSION)
    expect(manifest.encryption.algorithm).toBe('xchacha20poly1305')
    expect(manifest.encryption.keyId).toBe(deriveKeyId(key))
    expect(manifest.encryption.keyChallenge).toMatch(/^enc:v1:/)
    expect(await verifyKeyAgainstChallenge(key, manifest)).toBe(true)
  })

  // CA-03 (crypto half): wrong key fails the challenge without throwing
  it('rejects a wrong key against the challenge', async () => {
    const key = await generateWorkspaceKey()
    const other = await generateWorkspaceKey()
    const manifest = await buildManifest(key)
    expect(await verifyKeyAgainstChallenge(other, manifest)).toBe(false)
  })

  it('serialize → parse round-trips', async () => {
    const key = await generateWorkspaceKey()
    const manifest = await buildManifest(key)
    const parsed = parseManifest(serializeManifest(manifest))
    expect(parsed).toEqual(manifest)
  })

  it('rejects invalid JSON', () => {
    expect(() => parseManifest('{ not json')).toThrow(/WORKSPACE_INVALID|JSON/i)
  })

  it('rejects an unknown version', () => {
    const raw = JSON.stringify({
      version: 99,
      encryption: { algorithm: 'xchacha20poly1305', keyChallenge: 'enc:v1:x', keyId: 'abc' }
    })
    expect(() => parseManifest(raw)).toThrow(/version/i)
  })

  it('rejects a missing field', () => {
    const raw = JSON.stringify({ version: MANIFEST_VERSION, encryption: { algorithm: 'x' } })
    expect(() => parseManifest(raw)).toThrow(/required fields|algorithm/i)
  })
})
