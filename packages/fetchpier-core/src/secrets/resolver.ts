/**
 * REQ-0070 — Lazy secret resolution (pure, shared by desktop + CLI).
 *
 * Given the environment's `secrets` map, the set of variable names a request
 * actually references, and a key-bound `decrypt` callback, resolve only the
 * referenced secrets to plaintext. Contractual errors (§7.1) are thrown so the
 * adapter (desktop IPC / CLI) surfaces them before any request is emitted.
 *
 * Key custody stays adapter-side: this module never sees the workspace key, only
 * a `decrypt(name, encValue)` callback that binds it.
 */

import type { HttpRequest } from '@shared/types'
import { CoreError } from '../shared/context'
import { isEncryptedValue } from './crypto'
import { keyMissingError, valueCorruptError, valueUnsetError } from './errors'

const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g

function addRefs(text: string | undefined, into: Set<string>): void {
  if (!text) return
  for (const match of text.matchAll(VARIABLE_PATTERN)) into.add(match[1].trim())
}

/**
 * Collect every `{{variable}}` name referenced by a request — across URL,
 * structured query params, header keys/values, body, form fields, multipart
 * parts, and the auth config's value fields. Used to scope lazy secret
 * decryption to what the request needs.
 */
export function collectReferencedVariableNames(request: HttpRequest): Set<string> {
  const names = new Set<string>()
  addRefs(request.url, names)
  // REQ-0081: the query crosses the boundary as a structured list (not baked
  // into `url`), so a secret referenced only in a query param lives here — it
  // must be scanned or the marker is never seeded and the token travels literal.
  //
  // Disabled rows (params / fields `enabled: false`, parts `disabled: true`) are
  // never sent, so they do not scope decryption: the desktop payload carries them,
  // and a disabled row's needs-value or locked secret must not refuse the send.
  for (const p of request.params ?? []) {
    if (p.enabled === false) continue
    addRefs(p.key, names)
    addRefs(p.value, names)
  }
  // SEC-02: the ordered `headerList` is authoritative for the wire (mirrors
  // `resolveRequestVariables`); the last-wins record drops an earlier same-name
  // header, so it is only the fallback when no list travels.
  const headerPairs: Array<[string, string]> = request.headerList
    ? request.headerList.map((h) => [h.name, h.value])
    : Object.entries(request.headers ?? {})
  for (const [k, v] of headerPairs) {
    addRefs(k, names)
    addRefs(v, names)
  }
  addRefs(request.body, names)
  for (const f of request.formFields ?? []) {
    if (f.enabled === false) continue
    addRefs(f.key, names)
    addRefs(f.value, names)
  }
  for (const p of request.multipartParts ?? []) {
    if (p.disabled === true) continue
    addRefs(p.name, names)
    addRefs(p.contentType, names)
    if (p.kind === 'text') addRefs(p.value, names)
    else addRefs(p.filename, names)
  }
  const auth = request.auth
  if (auth && auth.type !== 'none') {
    if (auth.type === 'bearer') addRefs(auth.token, names)
    else if (auth.type === 'basic') {
      addRefs(auth.username, names)
      addRefs(auth.password, names)
    } else if (auth.type === 'api-key') {
      addRefs(auth.key, names)
      addRefs(auth.value, names)
    }
  }
  return names
}

export interface ResolveSecretsInput {
  environmentId: string
  /** The environment's secrets map (variable name → `enc:` string | null). */
  secretsMap: Record<string, string | null>
  /** Variable names referenced by the request (the lazy decryption scope). */
  neededNames: Iterable<string>
  /** Whether a workspace key is available to decrypt. */
  hasKey: boolean
  /**
   * Decrypt one secret value with the workspace key (bound by the adapter).
   * May throw a `SECRETS_VALUE_CORRUPT` `CoreError`; the env/variable context is
   * added here.
   */
  decrypt: (name: string, encValue: string) => Promise<string>
}

/**
 * Resolve the referenced secret variables to plaintext. Returns a map of
 * `name → plaintext` for the referenced secrets only (lazy). Throws:
 *
 * - `SECRETS_VALUE_UNSET` — a referenced secret is `null` (needs-value). Highest
 *   precedence, detectable without a key (§6.10).
 * - `SECRETS_KEY_MISSING` — a referenced secret needs decryption and no key is
 *   available.
 * - `SECRETS_VALUE_CORRUPT` — a value is not a valid `enc:` string, or fails
 *   authentication. Names the environment and variable.
 */
export async function resolveSecrets(input: ResolveSecretsInput): Promise<Record<string, string>> {
  const { environmentId, secretsMap, hasKey, decrypt } = input
  const needed = [...new Set(input.neededNames)].filter((name) =>
    Object.prototype.hasOwnProperty.call(secretsMap, name)
  )

  // 1. needs-value (null) — key-independent, highest precedence (CA-13).
  for (const name of needed) {
    if (secretsMap[name] === null) throw valueUnsetError(environmentId, name)
  }

  // 2. key availability (lazy: only when a secret is actually referenced).
  if (needed.length > 0 && !hasKey) {
    throw keyMissingError(needed[0])
  }

  // 3. decryption.
  const out: Record<string, string> = {}
  for (const name of needed) {
    const enc = secretsMap[name]
    if (enc === null || enc === undefined) continue // handled in pass 1
    if (!isEncryptedValue(enc)) {
      // A non-enc, non-null value (e.g. a hand-pasted foreign-key folder copy).
      throw valueCorruptError(environmentId, name, 'not an encrypted value')
    }
    try {
      out[name] = await decrypt(name, enc)
    } catch (err) {
      const reason =
        err instanceof CoreError ? (err.details?.reason as string | undefined) : undefined
      throw valueCorruptError(environmentId, name, reason)
    }
  }
  return out
}
