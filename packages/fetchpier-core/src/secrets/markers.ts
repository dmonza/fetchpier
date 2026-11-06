/**
 * REQ-0070 — Position-based masking via interpolation markers (§6.6).
 *
 * When a secret variable is interpolated, the engine substitutes an internal
 * marker instead of the value:
 *
 *   {$secret:<name>:<nonce>}
 *
 * `<nonce>` is 4 CSPRNG bytes (8 hex) minted once per execution (each desktop
 * send, each CLI request run), shared by all markers of that execution and
 * discarded afterwards. The marked text is rendered twice:
 *
 * - **Wire render** — markers carrying *this execution's* nonce are replaced by
 *   the decrypted value. Marker-shaped text with any other nonce (user-authored,
 *   server-injected, script-copied) does not match and passes through inert.
 * - **Log render** — markers are replaced by the named mask `{secret:<name>}`.
 *   The log mask deliberately differs in shape (no `$`, no nonce) so logged
 *   entries can never be re-resolved as markers.
 *
 * Response echoes have no marker, so they are masked by substring match against
 * the exact decrypted values as a best-effort net.
 *
 * The execution nonce uses `node:crypto` (no libsodium dependency): it needs
 * unpredictability to content authors, not the uniqueness guarantees of the
 * 24-byte AEAD nonce.
 */

import { randomBytes } from 'node:crypto'

/** Mint a per-execution nonce (8 hex chars). */
export function mintExecutionNonce(): string {
  return randomBytes(4).toString('hex')
}

/** Build the interpolation marker for a secret variable in this execution. */
export function secretMarker(name: string, nonce: string): string {
  return `{$secret:${name}:${nonce}}`
}

/** The named log mask for a secret variable (no nonce — cannot be re-resolved). */
export function secretLogMask(name: string): string {
  return `{secret:${name}}`
}

export interface SecretMaskerInput {
  /** This execution's nonce (from {@link mintExecutionNonce}). */
  nonce: string
  /** Decrypted plaintext for each referenced secret variable name. */
  plaintextByName: Record<string, string>
}

/**
 * Render helpers bound to a single execution's nonce and resolved secrets. The
 * adapter builds one per send/run and passes it into `requests.execute`.
 */
export interface SecretMasker {
  /** Variable map entries (name → marker) to seed interpolation. */
  readonly markerVariables: Record<string, string>
  /** Plaintext secrets for the script sandbox environment (§6.4). */
  readonly scriptEnvironment: Record<string, string>
  /** Replace this execution's markers with decrypted values (wire boundary). */
  wireRender(text: string): string
  /** Replace this execution's markers with `{secret:<name>}` (logs/reporters). */
  logRender(text: string): string
  /** Names whose marker appears in any of the supplied resolved texts. */
  collectMaskedNames(texts: Array<string | undefined>): string[]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createSecretMasker(input: SecretMaskerInput): SecretMasker {
  const { nonce, plaintextByName } = input
  const names = Object.keys(plaintextByName)

  const markerVariables: Record<string, string> = {}
  for (const name of names) markerVariables[name] = secretMarker(name, nonce)

  // Matches only THIS execution's markers. A marker carrying any other nonce
  // fails this pattern and is left untouched (anti-injection, CA-15).
  const markerSource = `\\{\\$secret:([^:{}]+):${escapeRegExp(nonce)}\\}`

  const wireRender = (text: string): string =>
    text.replace(new RegExp(markerSource, 'g'), (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(plaintextByName, name) ? plaintextByName[name] : whole
    )

  const logRender = (text: string): string =>
    text.replace(new RegExp(markerSource, 'g'), (_whole, name: string) => secretLogMask(name))

  const collectMaskedNames = (texts: Array<string | undefined>): string[] => {
    const found: string[] = []
    for (const name of names) {
      const marker = markerVariables[name]
      if (texts.some((t) => t !== undefined && t.includes(marker))) found.push(name)
    }
    return found
  }

  return {
    markerVariables,
    scriptEnvironment: { ...plaintextByName },
    wireRender,
    logRender,
    collectMaskedNames
  }
}
