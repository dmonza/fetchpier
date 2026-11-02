import { describe, expect, it } from 'vitest'
import { CoreError } from '../shared/context'
import {
  decryptValue,
  encryptValue,
  generateWorkspaceKey,
  isEncryptedValue,
  KEY_BYTES
} from './crypto'

describe('encryptValue / decryptValue', () => {
  it('round-trips a value with the variable name as AD', async () => {
    const key = await generateWorkspaceKey()
    const enc = await encryptValue(key, 'apiToken', 'super-secret')
    expect(enc).toMatch(/^enc:v1:/)
    expect(enc).not.toContain('super-secret')
    const out = await decryptValue(key, 'apiToken', enc)
    expect(out).toBe('super-secret')
  })

  it('round-trips an empty string (distinct from null/needs-value)', async () => {
    const key = await generateWorkspaceKey()
    const enc = await encryptValue(key, 'x', '')
    expect(isEncryptedValue(enc)).toBe(true)
    expect(await decryptValue(key, 'x', enc)).toBe('')
  })

  it('round-trips unicode', async () => {
    const key = await generateWorkspaceKey()
    const value = 'çãé—🔐—Ω'
    const enc = await encryptValue(key, 'v', value)
    expect(await decryptValue(key, 'v', enc)).toBe(value)
  })

  // CA-12: fresh nonce per encryption
  it('produces different ciphertext for the same plaintext (nonce freshness)', async () => {
    const key = await generateWorkspaceKey()
    const a = await encryptValue(key, 'token', 'same')
    const b = await encryptValue(key, 'token', 'same')
    expect(a).not.toBe(b)
  })

  // CA-08: AD binds the ciphertext to its variable name
  it('fails when decrypted under a different variable name (transplant)', async () => {
    const key = await generateWorkspaceKey()
    const enc = await encryptValue(key, 'stagingToken', 'val')
    await expect(decryptValue(key, 'prodToken', enc)).rejects.toMatchObject({
      code: 'SECRETS_VALUE_CORRUPT'
    })
  })

  // CA-07: tamper detection
  it('detects a single flipped byte in the payload', async () => {
    const key = await generateWorkspaceKey()
    const enc = await encryptValue(key, 'v', 'value')
    const b64 = enc.slice('enc:v1:'.length)
    const buf = Buffer.from(b64, 'base64')
    buf[buf.length - 1] ^= 0x01
    const tampered = `enc:v1:${buf.toString('base64')}`
    await expect(decryptValue(key, 'v', tampered)).rejects.toMatchObject({
      code: 'SECRETS_VALUE_CORRUPT'
    })
  })

  it('fails for a wrong key', async () => {
    const key = await generateWorkspaceKey()
    const other = await generateWorkspaceKey()
    const enc = await encryptValue(key, 'v', 'value')
    await expect(decryptValue(other, 'v', enc)).rejects.toMatchObject({
      code: 'SECRETS_VALUE_CORRUPT'
    })
  })

  it('rejects a malformed string', async () => {
    const key = await generateWorkspaceKey()
    await expect(decryptValue(key, 'v', 'not-an-enc-string')).rejects.toBeInstanceOf(CoreError)
    await expect(decryptValue(key, 'v', 'enc:v1:%%%')).rejects.toMatchObject({
      code: 'SECRETS_VALUE_CORRUPT'
    })
  })

  it('rejects an unknown version', async () => {
    const key = await generateWorkspaceKey()
    const enc = await encryptValue(key, 'v', 'value')
    const future = enc.replace('enc:v1:', 'enc:v2:')
    await expect(decryptValue(key, 'v', future)).rejects.toMatchObject({
      code: 'SECRETS_VALUE_CORRUPT'
    })
  })

  it('rejects a key of the wrong length', async () => {
    const bad = new Uint8Array(KEY_BYTES - 1)
    await expect(encryptValue(bad, 'v', 'x')).rejects.toMatchObject({
      code: 'SECRETS_KEY_INVALID'
    })
  })
})

describe('isEncryptedValue', () => {
  it('recognizes enc: strings only', () => {
    expect(isEncryptedValue('enc:v1:abc')).toBe(true)
    expect(isEncryptedValue('plain')).toBe(false)
    expect(isEncryptedValue(null)).toBe(false)
    expect(isEncryptedValue(123)).toBe(false)
  })
})
