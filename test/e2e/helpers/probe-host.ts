import { _electron as electron } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { KeystoreBackend } from '../../../src/shared/types'
import { APP_LAUNCH_PATH } from './electron-app'
import { buildSeededSettings } from './settings-seed'
import { readSandboxObservation, type SandboxObservation } from './renderer-sandbox'

// The I/O half of the host-precondition guard: launch the built app exactly
// once, before any spec, and read back the two facts that are properties of the
// machine rather than of the product.
//
// Why launch at all instead of reading a kernel toggle: a host-capability proxy
// predicts, it does not observe. The sandbox invariant already rejects that class of
// signal for this invariant — the assertion deliberately reads what the OS
// applied, not what was requested — and a precondition guarding that invariant
// has to meet the same bar. One launch (~1–2 s) buys an observation of the real
// thing.
//
// The launch mirrors the specs' own configuration (same switches, no
// `--no-sandbox`), otherwise the precondition would be measuring a different
// app than the one under test.

export interface HostProbe {
  sandbox: SandboxObservation
  keyringBackend: KeystoreBackend
}

/**
 * Detect the custody backend from the main process.
 *
 * This MIRRORS `src/main/secrets/backend.ts` (`detectBackend`). It is not
 * imported because the built bundle exposes no such entry point, and it is not
 * read over IPC because `secrets:status` requires an active workspace and
 * `secrets:listKeys` reports a backend only once a key exists — neither holds
 * for a probe that must stay cheap and workspace-free.
 *
 * If `detectBackend` ever changes, this must change with it. The cost of drift
 * is bounded: the probe would wave through a host the specs then fail on, which
 * is exactly today's behavior, not worse.
 */
const READ_BACKEND = ({ safeStorage }: typeof import('electron')): KeystoreBackend => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'session-only'
    const getSelected = (safeStorage as unknown as { getSelectedStorageBackend?: () => string })
      .getSelectedStorageBackend
    if (typeof getSelected === 'function' && getSelected.call(safeStorage) === 'basic_text') {
      return 'session-only'
    }
    return 'os-keychain'
  } catch {
    return 'session-only'
  }
}

/** Boot into the "no workspace" state: nothing to open, no dialog over the UI. */
async function seedProbeUserData(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.writeFile(
    join(userDataDir, 'last-workspace.json'),
    JSON.stringify({ path: '', recent: [] }, null, 2),
    'utf-8'
  )
  await fs.writeFile(
    join(userDataDir, 'appsettings.json'),
    JSON.stringify(
      buildSeededSettings({
        language: 'en',
        lastVersion: '0.0.0-probe',
        updates: {
          autoCheckEnabled: false,
          intervalDays: 30,
          lastCheckAt: new Date().toISOString()
        },
        theme: 'system'
      }),
      null,
      2
    ),
    'utf-8'
  )
}

export async function probeHost(): Promise<HostProbe> {
  const userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-e2e-probe-'))
  await seedProbeUserData(userDataDir)

  const app = await electron.launch({
    // Must match `launchApp` — a probe running a different configuration than
    // the specs would be answering a different question.
    args: [APP_LAUNCH_PATH, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    env: { ...process.env, FETCHPIER_DISABLE_UPDATES: '1' }
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    const sandbox = await readSandboxObservation(app)
    const keyringBackend = await app.evaluate(READ_BACKEND)

    return { sandbox, keyringBackend }
  } finally {
    await app.close().catch(() => {
      // Already gone — nothing to clean up on the app side.
    })
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {
      // Best-effort: a leftover tmpdir must never fail the run.
    })
  }
}
