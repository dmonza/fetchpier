/**
 * REQ-0070 — Workspace key presentation format (pure, shared by desktop + CLI).
 *
 * Human-readable form shown for backup/sharing and accepted by the enter-key
 * dialog / `FETCHPIER_WORKSPACE_KEY`:
 *
 *   FPK1-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX
 *
 * - `FPK1` — format/version prefix.
 * - 8 groups of 7 characters, Crockford Base32 (uppercase, no `I L O U`).
 * - Payload = 32-byte key + 3-byte CRC-24 = 35 bytes = exactly 56 Base32 chars.
 *
 * Per REQ-0072 §5.2 (canonical): 8 groups of 7 chars + a 3-byte CRC-24 so the
 * 35-byte payload tiles 56 Base32 chars exactly. (This supersedes REQ-0070's
 * "8 groups of 6 chars + 2-byte CRC", which was internally inconsistent — 48
 * Base32 chars hold only 30 bytes, but the 32-byte key is fixed by the cipher.)
 * Parsing is case-insensitive and tolerant of missing/extra hyphens, so the
 * grouping is cosmetic.
 *
 * `keyId` is the first 8 bytes of SHA-256(key) as 16 hex chars, computed with
 * `node:crypto` — it must not depend on the libsodium WASM load.
 */

import { createHash } from 'node:crypto'
import { CoreError } from '../shared/context'
import { KEY_BYTES } from './crypto'

/** Crockford Base32 alphabet (32 symbols; excludes I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const KEY_PREFIX = 'FPK1'
const CRC_BYTES = 3
const GROUP_SIZE = 7
const GROUP_COUNT = 8
/** 35 payload bytes → 280 bits → 56 Base32 symbols (no remainder). */
const PAYLOAD_BYTES = KEY_BYTES + CRC_BYTES
const ENCODED_CHARS = GROUP_SIZE * GROUP_COUNT

/** OpenPGP-style CRC-24 (RFC 4880). Returns 3 big-endian bytes. */
function crc24(data: Uint8Array): Uint8Array {
  let crc = 0xb704ce
  for (const byte of data) {
    crc ^= byte << 16
    for (let i = 0; i < 8; i++) {
      crc <<= 1
      if (crc & 0x1000000) crc ^= 0x1864cfb
    }
  }
  crc &= 0xffffff
  return Uint8Array.from([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff])
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 31]
  }
  return out
}

function decodeBase32(symbols: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of symbols) {
    const idx = CROCKFORD.indexOf(ch)
    if (idx === -1) {
      throw new CoreError('SECRETS_KEY_INVALID', `Invalid character "${ch}" in workspace key.`)
    }
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** Normalize Crockford input: uppercase and fold the ambiguous letters. */
function normalizeSymbols(s: string): string {
  return s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
}

/** Format a raw 32-byte key as `FPK1-…`. */
export function formatKey(rawKey: Uint8Array): string {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== KEY_BYTES) {
    throw new CoreError('SECRETS_KEY_INVALID', `Workspace key must be ${KEY_BYTES} bytes.`)
  }
  const payload = new Uint8Array(PAYLOAD_BYTES)
  payload.set(rawKey, 0)
  payload.set(crc24(rawKey), KEY_BYTES)
  const encoded = encodeBase32(payload)
  const groups: string[] = []
  for (let i = 0; i < encoded.length; i += GROUP_SIZE) {
    groups.push(encoded.slice(i, i + GROUP_SIZE))
  }
  return `${KEY_PREFIX}-${groups.join('-')}`
}

/**
 * Parse an `FPK1-…` string into the raw 32-byte key. Case-insensitive and
 * hyphen/whitespace-tolerant. Throws `SECRETS_KEY_INVALID` for a wrong prefix,
 * wrong length, invalid character, or CRC mismatch — before any challenge
 * attempt (REQ §9.2).
 */
export function parseKey(input: string): Uint8Array {
  if (typeof input !== 'string') {
    throw new CoreError('SECRETS_KEY_INVALID', 'Workspace key must be a string.')
  }
  const compact = input.replace(/[\s-]+/g, '').toUpperCase()
  if (!compact.startsWith(KEY_PREFIX)) {
    throw new CoreError('SECRETS_KEY_INVALID', 'Workspace key must start with "FPK1-".')
  }
  const body = normalizeSymbols(compact.slice(KEY_PREFIX.length))
  if (body.length !== ENCODED_CHARS) {
    throw new CoreError('SECRETS_KEY_INVALID', 'Workspace key has the wrong length.')
  }
  const payload = decodeBase32(body)
  if (payload.length !== PAYLOAD_BYTES) {
    throw new CoreError('SECRETS_KEY_INVALID', 'Workspace key has the wrong length.')
  }
  const key = payload.slice(0, KEY_BYTES)
  const crc = payload.slice(KEY_BYTES)
  const expected = crc24(key)
  if (crc[0] !== expected[0] || crc[1] !== expected[1] || crc[2] !== expected[2]) {
    throw new CoreError('SECRETS_KEY_INVALID', 'Workspace key checksum failed — check for typos.')
  }
  return key
}

/**
 * Derive the 16-hex-char keyId (first 8 bytes of SHA-256(key)). Lets the UI,
 * errors, and keystore reference *which* key is expected without revealing it.
 * Not a security boundary — verification is always the challenge.
 */
export function deriveKeyId(rawKey: Uint8Array): string {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== KEY_BYTES) {
    throw new CoreError('SECRETS_KEY_INVALID', `Workspace key must be ${KEY_BYTES} bytes.`)
  }
  const digest = createHash('sha256').update(rawKey).digest()
  return digest.subarray(0, 8).toString('hex')
}
