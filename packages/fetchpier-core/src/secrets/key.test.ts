import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { deriveKeyId, formatKey, parseKey } from './key'
import { KEY_BYTES } from './crypto'

function rawKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES))
}

describe('formatKey', () => {
  it('produces FPK1- + 8 Base32 groups of 7 chars', () => {
    const str = formatKey(rawKey())
    expect(str.startsWith('FPK1-')).toBe(true)
    const groups = str.slice('FPK1-'.length).split('-')
    expect(groups).toHaveLength(8)
    for (const g of groups) {
      expect(g).toHaveLength(7)
      expect(g).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/) // Crockford: no I L O U
    }
  })

  it('rejects a key of the wrong length', () => {
    expect(() => formatKey(new Uint8Array(10))).toThrow(/SECRETS|32 bytes/i)
  })
})

describe('parseKey', () => {
  it('round-trips format → parse', () => {
    const key = rawKey()
    const parsed = parseKey(formatKey(key))
    expect([...parsed]).toEqual([...key])
  })

  it('is case-insensitive and hyphen-tolerant', () => {
    const key = rawKey()
    const str = formatKey(key)
    const lowerNoHyphens = str.toLowerCase().replace(/-/g, '')
    expect([...parseKey(lowerNoHyphens)]).toEqual([...key])
    // extra/odd hyphens and surrounding whitespace
    const messy = `  ${str.replace(/-/g, '--')}  `
    expect([...parseKey(messy)]).toEqual([...key])
  })

  it('folds ambiguous Crockford letters (O→0, I/L→1)', () => {
    const key = rawKey()
    // Fold only the body; the literal "FPK1-" prefix must stay intact.
    const str = formatKey(key)
    const body = str.slice('FPK1-'.length).replace(/0/g, 'O').replace(/1/g, 'I')
    expect([...parseKey(`FPK1-${body}`)]).toEqual([...key])
  })

  it('rejects a CRC-failing string before any other use', () => {
    const key = rawKey()
    const str = formatKey(key)
    // Flip a character in the key body so the CRC no longer matches.
    const idx = 'FPK1-'.length + 2
    const ch = str[idx]
    const replacement = ch === 'A' ? 'B' : 'A'
    const broken = str.slice(0, idx) + replacement + str.slice(idx + 1)
    expect(() => parseKey(broken)).toThrow(/checksum|SECRETS_KEY_INVALID/i)
  })

  it('rejects wrong prefix', () => {
    expect(() => parseKey('XXXX-AAAAAAA')).toThrow(/FPK1/i)
  })

  it('rejects wrong length', () => {
    expect(() => parseKey('FPK1-ABC')).toThrow(/length/i)
  })

  it('rejects an invalid character', () => {
    // 'U' is not in the Crockford alphabet and is not folded.
    const key = rawKey()
    const str = formatKey(key)
    const idx = 'FPK1-'.length
    const broken = str.slice(0, idx) + 'U' + str.slice(idx + 1)
    expect(() => parseKey(broken)).toThrow()
  })
})

describe('deriveKeyId', () => {
  it('is 16 hex chars and stable for a given key', () => {
    const key = rawKey()
    const id = deriveKeyId(key)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(deriveKeyId(key)).toBe(id)
  })

  it('differs for different keys', () => {
    expect(deriveKeyId(rawKey())).not.toBe(deriveKeyId(rawKey()))
  })
})
