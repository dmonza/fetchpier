/**
 * REQ-0070 — Per-session live workspace keys, indexed by keyId (key identity).
 *
 * This is the in-memory cache both backends use during a session. For the
 * `os-keychain` backend it is repopulated lazily from the persistent keystore;
 * for `session-only` it is the sole home of the key until the app quits.
 *
 * Cleared by `lockAll` (a full lock) and on quit. A workspace switch clears it
 * only on `os-keychain`; `session-only` keys survive it.
 */

const liveKeys = new Map<string, Uint8Array>()

export function rememberKey(keyId: string, rawKey: Uint8Array): void {
  liveKeys.set(keyId, rawKey)
}

export function getLiveKey(keyId: string): Uint8Array | undefined {
  return liveKeys.get(keyId)
}

/** Drop a single live key (REQ-0073 delete). No-op if absent. */
export function forgetKey(keyId: string): void {
  liveKeys.delete(keyId)
}

export function isUnlocked(keyId: string): boolean {
  return liveKeys.has(keyId)
}

/** Drop every live key (a full lock; also on a workspace switch on `os-keychain`). */
export function lockAll(): void {
  liveKeys.clear()
}
