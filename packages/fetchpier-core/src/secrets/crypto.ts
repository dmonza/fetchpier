/**
 * REQ-0070 — Encrypted value primitive (pure, shared by desktop + CLI).
 *
 * Format of an encrypted string (the values of the `secrets` map and the key
 * challenge):
 *
 *   enc:v1:<base64(nonce[24] || ciphertext || tag[16])>
 *
 * AEAD is XChaCha20-Poly1305 (libsodium `crypto_aead_xchacha20poly1305_ietf_*`),
 * combined mode (the 16-byte Poly1305 tag is appended to the ciphertext). The
 * 24-byte nonce is random per encryption (CSPRNG) so encryptions are stateless —
 * no counter to coordinate across machines or merges.
 *
 * Associated data (AD) binds each ciphertext to a context string: the UTF-8
 * variable name for variable values, or the literal `challenge` for the key
 * challenge. Transplanting a ciphertext to a different variable fails auth.
 *
 * libsodium is loaded **lazily** via dynamic `import()` on first use, never at
 * module top level: that keeps the ~300 KB WASM out of the cold-path bundle
 * (mirrors the REQ-0063 schema-import split) and means a run that touches no
 * secret loads neither the key nor the WASM.
 */

import { createRequire } from 'node:module'
import { CoreError } from '../shared/context'

const ENC_PREFIX = 'enc'
const ENC_VERSION = 'v1'

/** XChaCha20-Poly1305 IETF nonce length. */
export const NONCE_BYTES = 24
/** Poly1305 tag length (combined-mode ciphertext = message + this). */
export const TAG_BYTES = 16
/** Symmetric workspace-key length. Fixed by the cipher. */
export const KEY_BYTES = 32

/** Minimal surface of `libsodium-wrappers` we depend on. */
interface SodiumLike {
  ready: Promise<void>
  randombytes_buf(length: number): Uint8Array
  crypto_aead_xchacha20poly1305_ietf_keygen(): Uint8Array
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: Uint8Array | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array
}

let sodiumPromise: Promise<SodiumLike> | null = null

/**
 * Lazily load libsodium-wrappers and await its WASM init. Loaded on first use,
 * never at module top level — that keeps the WASM out of the boot path (a run
 * touching no secret loads neither the key nor the WASM). The promise is cached
 * so the instantiation cost is paid once per process.
 *
 * We deliberately load through `createRequire` (CommonJS), not `import()`:
 * libsodium-wrappers ships a broken ESM build (its `.mjs` imports a sibling that
 * is not published), so the `exports.import` condition fails at runtime. The
 * CommonJS entry (`exports.require`) is the only working one, and Node's real
 * resolver reaches it identically under the desktop bundle, the CLI, and vitest.
 */
export async function loadSodium(): Promise<SodiumLike> {
  if (!sodiumPromise) {
    sodiumPromise = (async () => {
      // Anchor for module resolution. The desktop and CLI bundles are CommonJS,
      // where `__filename` is defined; vitest runs the ESM source, where
      // `import.meta.url` is the one available. esbuild replaces `import.meta`
      // with `{}` in the CJS output, but that branch is never taken there.
      const anchor = typeof __filename !== 'undefined' ? __filename : import.meta.url
      const requireFrom = createRequire(anchor)
      const sodium = requireFrom('libsodium-wrappers') as SodiumLike
      await sodium.ready
      return sodium
    })()
  }
  return sodiumPromise
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new CoreError('SECRETS_KEY_INVALID', `Workspace key must be ${KEY_BYTES} bytes.`)
  }
}

/** True when a string looks like an encrypted value (`enc:` prefix). */
export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${ENC_PREFIX}:`)
}

/**
 * Parse an `enc:v1:<base64>` string into its raw payload. Throws
 * `SECRETS_VALUE_CORRUPT` for a malformed string or an unknown version — never
 * silently skips (REQ §5.2).
 */
function parsePayload(encStr: string): Uint8Array {
  if (typeof encStr !== 'string') {
    throw new CoreError('SECRETS_VALUE_CORRUPT', 'Encrypted value is not a string.', {
      reason: 'malformed'
    })
  }
  const match = /^enc:([^:]+):(.*)$/s.exec(encStr)
  if (!match) {
    throw new CoreError('SECRETS_VALUE_CORRUPT', 'Malformed encrypted value (expected enc:v1:…).', {
      reason: 'malformed'
    })
  }
  const [, version, b64] = match
  if (version !== ENC_VERSION) {
    throw new CoreError(
      'SECRETS_VALUE_CORRUPT',
      `Unsupported encrypted-value version "${version}". Upgrade Fetchpier to read it.`,
      { reason: 'unknown-version' }
    )
  }
  const payload = Buffer.from(b64, 'base64')
  if (payload.length < NONCE_BYTES + TAG_BYTES) {
    throw new CoreError('SECRETS_VALUE_CORRUPT', 'Encrypted payload is too short.', {
      reason: 'malformed'
    })
  }
  return new Uint8Array(payload)
}

/**
 * Encrypt a plaintext value. `associatedData` is the variable name (or the
 * literal `challenge` for the key challenge). Produces a fresh nonce every call.
 */
export async function encryptValue(
  rawKey: Uint8Array,
  associatedData: string,
  plaintext: string
): Promise<string> {
  assertKey(rawKey)
  const sodium = await loadSodium()
  const nonce = sodium.randombytes_buf(NONCE_BYTES)
  const ad = new TextEncoder().encode(associatedData)
  const message = new TextEncoder().encode(plaintext)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    message,
    ad,
    null,
    nonce,
    rawKey
  )
  const out = new Uint8Array(nonce.length + ciphertext.length)
  out.set(nonce, 0)
  out.set(ciphertext, nonce.length)
  return `${ENC_PREFIX}:${ENC_VERSION}:${Buffer.from(out).toString('base64')}`
}

/**
 * Decrypt an encrypted value. `associatedData` must match the value used at
 * encryption (the variable name, or `challenge`). Failure modes all surface as
 * `SECRETS_VALUE_CORRUPT`: malformed string, unknown version, or authentication
 * failure (wrong key / tampered ciphertext / wrong variable name). Never returns
 * garbage plaintext.
 */
export async function decryptValue(
  rawKey: Uint8Array,
  associatedData: string,
  encStr: string
): Promise<string> {
  assertKey(rawKey)
  const payload = parsePayload(encStr)
  const sodium = await loadSodium()
  const nonce = payload.slice(0, NONCE_BYTES)
  const ciphertext = payload.slice(NONCE_BYTES)
  const ad = new TextEncoder().encode(associatedData)
  let message: Uint8Array
  try {
    message = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, ad, nonce, rawKey)
  } catch {
    throw new CoreError(
      'SECRETS_VALUE_CORRUPT',
      'Secret value failed authentication (wrong key for this value, or tampered).',
      { reason: 'auth-failed' }
    )
  }
  return new TextDecoder().decode(message)
}

/** Generate a fresh 32-byte workspace key (CSPRNG, via libsodium). */
export async function generateWorkspaceKey(): Promise<Uint8Array> {
  const sodium = await loadSodium()
  return sodium.crypto_aead_xchacha20poly1305_ietf_keygen()
}
