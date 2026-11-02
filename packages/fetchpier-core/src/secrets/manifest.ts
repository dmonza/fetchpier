/**
 * REQ-0070 — Workspace secrets manifest (`.fetchpier/secrets.json`).
 *
 * Workspace-shared config that **must be committed**. It holds no secret
 * material: only the key challenge (an encrypted fixed plaintext anyone can
 * verify a key against) and format/version metadata. Pure — no filesystem.
 */

import { CoreError } from '../shared/context'
import { decryptValue, encryptValue } from './crypto'
import { deriveKeyId } from './key'

/** Fixed plaintext encrypted under the workspace key as the challenge. */
export const CHALLENGE_PLAINTEXT = 'fetchpier-key-challenge-v1'
/** Associated data for the challenge ciphertext (REQ §5.2). */
export const CHALLENGE_AD = 'challenge'
export const MANIFEST_VERSION = 1
export const SECRETS_ALGORITHM = 'xchacha20poly1305'

export interface SecretsManifest {
  version: number
  encryption: {
    algorithm: string
    keyChallenge: string
    keyId: string
  }
}

/** Build a fresh manifest for a newly generated key. */
export async function buildManifest(rawKey: Uint8Array): Promise<SecretsManifest> {
  const keyChallenge = await encryptValue(rawKey, CHALLENGE_AD, CHALLENGE_PLAINTEXT)
  return {
    version: MANIFEST_VERSION,
    encryption: {
      algorithm: SECRETS_ALGORITHM,
      keyChallenge,
      keyId: deriveKeyId(rawKey)
    }
  }
}

/**
 * Verify a key against a manifest's challenge. Returns false on any failure
 * (wrong key, tampered challenge) — never throws. Verification is the challenge,
 * not the keyId.
 */
export async function verifyKeyAgainstChallenge(
  rawKey: Uint8Array,
  manifest: SecretsManifest
): Promise<boolean> {
  try {
    const plaintext = await decryptValue(rawKey, CHALLENGE_AD, manifest.encryption.keyChallenge)
    return plaintext === CHALLENGE_PLAINTEXT
  } catch {
    return false
  }
}

export function serializeManifest(manifest: SecretsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Parse and validate a `secrets.json`. A structurally broken or unknown-version
 * manifest is a workspace-invalid condition (the manifest was hand-edited,
 * truncated, or written by a newer Fetchpier).
 */
export function parseManifest(raw: string): SecretsManifest {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new CoreError('WORKSPACE_INVALID', '.fetchpier/secrets.json is not valid JSON.')
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new CoreError('WORKSPACE_INVALID', '.fetchpier/secrets.json is not an object.')
  }
  const m = obj as Record<string, unknown>
  if (m.version !== MANIFEST_VERSION) {
    throw new CoreError(
      'WORKSPACE_INVALID',
      `Unsupported secrets.json version "${String(m.version)}". Upgrade Fetchpier.`
    )
  }
  const enc = m.encryption as Record<string, unknown> | undefined
  if (
    !enc ||
    typeof enc.algorithm !== 'string' ||
    typeof enc.keyChallenge !== 'string' ||
    typeof enc.keyId !== 'string'
  ) {
    throw new CoreError('WORKSPACE_INVALID', '.fetchpier/secrets.json is missing required fields.')
  }
  if (enc.algorithm !== SECRETS_ALGORITHM) {
    throw new CoreError(
      'WORKSPACE_INVALID',
      `Unsupported encryption algorithm "${enc.algorithm}" in secrets.json.`
    )
  }
  return {
    version: MANIFEST_VERSION,
    encryption: {
      algorithm: enc.algorithm,
      keyChallenge: enc.keyChallenge,
      keyId: enc.keyId
    }
  }
}
