import { safeStorage } from 'electron'

/**
 * REQ-0070 §6.5 — which custody backend is in effect.
 *
 * - `os-keychain` — `safeStorage` is backed by a real OS keyring; workspace keys
 *   are persisted (wrapped by the machine-local master key).
 * - `session-only` — Linux without a keyring (`safeStorage` reports the
 *   `basic_text` backend, a hardcoded-password fallback) or encryption is
 *   unavailable. Persisting under that is false security, so keys are held in
 *   memory for the session only and re-entered next launch.
 */
export type KeystoreBackend = 'os-keychain' | 'session-only'

/** Detect the active backend. Only call after `app.whenReady()` + `app.setName()`. */
export function detectBackend(): KeystoreBackend {
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'session-only'
    const getSelected = (safeStorage as unknown as { getSelectedStorageBackend?: () => string })
      .getSelectedStorageBackend
    if (typeof getSelected === 'function') {
      // Linux-only API; on macOS/Windows it is absent and the keyring is real.
      const selected = getSelected.call(safeStorage)
      if (selected === 'basic_text') return 'session-only'
    }
    return 'os-keychain'
  } catch {
    return 'session-only'
  }
}
