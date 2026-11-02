/**
 * REQ-0070 §6.9 — re-authentication gate for revealing a single secret value.
 *
 * A UX-level control against a person at an unlocked machine — NOT a
 * cryptographic boundary (the workspace key is already in main-process memory).
 *
 * - macOS: Touch ID via `systemPreferences.promptTouchID` when available; Macs
 *   without Touch ID pass through (the API has no password fallback).
 * - Windows / Linux (this wave): pass-through (native module deferred, §2.2).
 *
 * A successful consent opens a 5-minute grace window (main-process memory only),
 * reset on app quit and on workspace lock.
 */

import { systemPreferences } from 'electron'

const GRACE_MS = 5 * 60 * 1000
let lastConsentAt = 0

/** Reset the grace window. Called on workspace lock and app quit. */
export function resetGrace(): void {
  lastConsentAt = 0
}

/**
 * Run the gate. Returns true when the reveal may proceed, false when the user
 * declined/failed the OS prompt.
 */
export async function runRevealGate(reason: string): Promise<boolean> {
  if (Date.now() - lastConsentAt < GRACE_MS) return true

  if (process.platform === 'darwin') {
    try {
      if (systemPreferences.canPromptTouchID()) {
        await systemPreferences.promptTouchID(reason)
        lastConsentAt = Date.now()
        return true
      }
    } catch {
      // User cancelled or authentication failed — do not reveal.
      return false
    }
  }

  // macOS without Touch ID, and Windows/Linux this wave: pass-through.
  lastConsentAt = Date.now()
  return true
}
