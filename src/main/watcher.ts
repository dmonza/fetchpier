import { watch, FSWatcher } from 'chokidar'
import { promises as fs, realpathSync } from 'fs'
import { BrowserWindow } from 'electron'
import { workspace } from '@fetchpier/core'

let watcher: FSWatcher | null = null

/**
 * The workspace the live watcher belongs to. Recovery and re-scan both target
 * it, and both bail when it changes mid-flight — a workspace switch always wins
 * the race against an in-flight recovery.
 */
let currentWorkspace: string | null = null

/**
 * Failed re-establishment attempts since the last *external* start. Deliberately
 * NOT reset when a recovery attempt succeeds: a watcher that establishes and
 * immediately dies again would otherwise retry forever. Three attempts per
 * workspace session, then the advisory, then silence until the workspace is
 * opened again (REQ-0113 §6.3/§6.4).
 */
let recoveryAttempt = 0

/** True once the advisory has been sent; keeps it from repeating. */
let degraded = false

/** Re-entry guard: `establishWatcher` → `stopWatcher` must not re-trigger recovery. */
let recovering = false

let rescanTimer: ReturnType<typeof setTimeout> | null = null

/** Delays before each re-establishment attempt (REQ-0113 Q2): immediate, 1 s, 5 s. */
const RECOVERY_DELAYS_MS = [0, 1_000, 5_000]

/** Focus can fire in bursts (alt-tab, dialogs); collapse them into one read. */
const RESCAN_DEBOUNCE_MS = 300

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/**
 * Re-read the request tree and broadcast it. Idempotent and safe to call at any
 * time, which is what makes the focus re-scan a legitimate recovery lever.
 * A failed read leaves the previously broadcast tree on screen (REQ-0113 §7.2).
 */
async function readAndBroadcastTree(workspacePath: string): Promise<void> {
  try {
    const tree = await workspace.openWorkspace(workspacePath).tree.read()
    broadcast('filesystem:changed', tree)
  } catch (err) {
    console.error('[watcher] Failed to read tree after change:', err)
  }
}

/**
 * Create the watcher over `workspacePath`. Returns false when the request root
 * could not be ensured — the signal recovery uses to count a failed attempt.
 * The public `startWatcher` ignores it, preserving the long-standing rule that
 * a watcher hiccup never fails a workspace open.
 */
async function establishWatcher(workspacePath: string): Promise<boolean> {
  // REQ-0104: await the previous watcher's actual shutdown before creating
  // the replacement — otherwise the two chokidar instances briefly coexist
  // and the outgoing one can still deliver events from a workspace that is
  // no longer active.
  await stopWatcher()

  // Reads route through the workspace handle (REQ Core-owned workspace handle).
  const ws = workspace.openWorkspace(workspacePath)
  const root = ws.tree.requestsRoot()
  // Ensure the directory exists before chokidar starts — otherwise on Windows
  // chokidar emits an ENOENT and never recovers when the folder is created
  // afterwards. Awaited (it used to be fire-and-forget) because the realpath
  // below needs the directory to be there.
  try {
    await fs.mkdir(root, { recursive: true })
  } catch (err) {
    console.error('[watcher] mkdir requests/ failed:', err)
    return false
  }

  // Hand the watcher the OS-CANONICAL path, never the caller's string.
  //
  // libuv watches the path it is given but receives events carrying the path the
  // OS considers canonical. When the two differ it fails a prefix check
  // (`src/win/fs-event.c:72`) and calls `abort()` — the process dies instantly,
  // with no exception to catch and no stack. Paths that trigger it are ordinary:
  // a Windows 8.3 short name (`C:\Users\RUNNER~1\…`), a junction, a symlink, or
  // macOS's `/tmp` → `/private/tmp`.
  //
  // `.native` specifically: the JS `fs.realpath` does not reliably expand 8.3.
  // On failure keep the unresolved path — that is exactly today's behavior, and
  // a watcher hiccup should not fail the workspace open.
  let watchRoot = root
  try {
    watchRoot = realpathSync.native(root)
  } catch (err) {
    console.error('[watcher] realpath failed; watching the unresolved path:', err)
  }

  /**
   * Translate a chokidar path back into the namespace the caller opened.
   * `useFileSyncReconciliation` matches tabs by exact string equality, so a
   * resolved path would silently match nothing.
   */
  const toCallerPath = (p: string): string =>
    watchRoot !== root && p.startsWith(watchRoot) ? root + p.slice(watchRoot.length) : p

  watcher = watch(watchRoot, {
    // Dotfiles include `.runs/` (per-artifact activity log), the atomic-write
    // temp files (dot-prefixed on purpose), and any future hidden state. The
    // single dot-rule covers them all.
    ignored: /(^|[/\\])\../,
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    // Collapse a save's multi-write (and the rename-over-target) into a single
    // settled event so an external/own edit surfaces once, not as a storm
    // (REQ open-tab-file-reconciliation).
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  })

  // Structural changes (add/remove/move of files & folders) rebuild the whole
  // tree; open-tab reconciliation reads add/remove/move from the new tree.
  const broadcastTree = (): void => {
    void readAndBroadcastTree(workspacePath)
  }

  // A content edit to an existing request file — the single signal the open-tab
  // reconciler needs to reload a clean tab or flag a conflict on a modified one.
  // The tree is unchanged, so no tree rebuild is needed.
  const broadcastFileChanged = (path: string): void => {
    broadcast('filesystem:fileChanged', toCallerPath(path))
  }

  watcher
    .on('add', broadcastTree)
    .on('unlink', broadcastTree)
    .on('addDir', broadcastTree)
    .on('unlinkDir', broadcastTree)
    .on('change', broadcastFileChanged)
    // Without this listener the error is an unhandled EventEmitter event, which
    // in the main process surfaces as the runtime's generic crash dialog. On
    // Windows, deleting or renaming the watched folder from outside the app is
    // enough to trigger it — an ordinary act for a product whose premise is that
    // the workspace is edited with other tools (REQ-0113 §6.1).
    .on('error', handleWatcherError)

  currentWorkspace = workspacePath
  return true
}

/**
 * Contain a watcher error and try to recover.
 *
 * REQ-0113 Q1: every error is treated as potentially fatal. The subsystem does
 * not label its errors, and the same condition can leave watching alive or dead
 * depending on which internal path failed — so rather than guess from an error
 * code that varies by platform and by version, we simply re-establish. If
 * watching was in fact alive, the attempt is a cheap no-op; the alternative
 * (misclassifying a fatal error as transient) leaves the tree silently dead.
 */
function handleWatcherError(err: unknown): void {
  console.error('[watcher] watcher error:', err)
  void recoverWatching()
}

/**
 * Bounded re-establishment. On exhaustion the user is told (REQ-0113 §6.4) —
 * never on a transient error, never while an attempt is still pending, because
 * the user should not be interrupted for a condition the product can fix itself.
 */
async function recoverWatching(): Promise<void> {
  if (recovering || degraded) return
  const target = currentWorkspace
  if (!target) return

  recovering = true
  try {
    while (recoveryAttempt < RECOVERY_DELAYS_MS.length) {
      const delay = RECOVERY_DELAYS_MS[recoveryAttempt]
      recoveryAttempt += 1
      if (delay > 0) await sleep(delay)
      // A workspace switch that landed while we waited wins: the watcher it
      // established is the one that should survive.
      if (currentWorkspace !== null && currentWorkspace !== target) return

      if (await establishWatcher(target)) {
        await readAndBroadcastTree(target)
        return
      }
    }
    degraded = true
    broadcast('filesystem:watchDegraded', { workspacePath: target })
  } finally {
    recovering = false
  }
}

/**
 * Starts watching the user-tree (`<workspace>/requests/`).
 * On any file system change, re-reads the tree and sends it to all renderer
 * windows. Everything else under the workspace (`.fetchpier/`, `environments/`,
 * `requests/.runs/`) is ignored — it changes through dedicated IPC paths and
 * should not trigger sidebar refreshes.
 *
 * This is the *external* entry point (workspace open, system resume) and the only
 * place the recovery budget is refilled.
 */
export async function startWatcher(workspacePath: string): Promise<void> {
  recoveryAttempt = 0
  degraded = false
  await establishWatcher(workspacePath)
}

/**
 * Re-read the tree, debounced. The primary recovery lever, and deliberately
 * detection-free (REQ-0113 §6.2): it repairs the user-visible symptom whether
 * the watcher died with an error, stopped delivering events silently after a
 * sleep/resume cycle, or never delivered them at all on a network share. The
 * user's own workflow — leave, edit elsewhere, come back — is the trigger.
 */
export function requestRescan(): void {
  if (!currentWorkspace) return
  if (rescanTimer) clearTimeout(rescanTimer)
  rescanTimer = setTimeout(() => {
    rescanTimer = null
    const target = currentWorkspace
    if (target) void readAndBroadcastTree(target)
  }, RESCAN_DEBOUNCE_MS)
}

/**
 * Re-establish watching after the machine resumes from sleep, then re-scan.
 * A watcher that survived sleep is simply replaced; one that stopped delivering
 * events without erroring — the case nothing could detect — is repaired.
 */
export async function handleSystemResume(): Promise<void> {
  const target = currentWorkspace
  if (!target) return
  await startWatcher(target)
  await readAndBroadcastTree(target)
}

/** Stops the current watcher, if any, and waits for its shutdown to settle. */
export async function stopWatcher(): Promise<void> {
  if (rescanTimer) {
    clearTimeout(rescanTimer)
    rescanTimer = null
  }
  currentWorkspace = null
  if (watcher) {
    const closing = watcher
    watcher = null
    try {
      await closing.close()
    } catch (err) {
      // A failed shutdown must not block the next watcher from starting.
      console.error('[watcher] Error closing watcher:', err)
    }
  }
}
