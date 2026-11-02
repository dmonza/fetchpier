/**
 * REQ-0104 Stage 3: `stopWatcher` must await the chokidar instance's actual
 * shutdown before `startWatcher` creates its replacement — otherwise two
 * watchers briefly coexist and a stale one can still deliver events from the
 * workspace it no longer belongs to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const send = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }]
  }
}))

let mod: typeof import('./watcher')
let workspaceA: string
let workspaceB: string

async function makeWorkspace(prefix: string): Promise<string> {
  // `realpathSync.native` is load-bearing, not tidiness. On Windows `tmpdir()`
  // returns the 8.3 SHORT form whenever a path segment exceeds 8 characters —
  // GitHub's runners report `C:\Users\RUNNER~1\AppData\Local\Temp`. Hand that
  // short path to chokidar and libuv watches it, but the OS reports events with
  // the LONG path; `src/win/fs-event.c:72` asserts the two share a prefix
  // (`_wcsnicmp`), the check fails, and libuv calls `abort()`. The process dies
  // instantly with no JS stack, which surfaces as Vitest's opaque "Worker
  // exited unexpectedly". `.native` (uv_fs_realpath) expands the short form;
  // the JS `realpath` does not reliably. Never watch an unresolved temp path.
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), prefix)))
  await mkdir(join(dir, 'requests'), { recursive: true })
  return dir
}

/** Polls until `predicate()` is true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return // caller asserts the final state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeEach(async () => {
  send.mockClear()
  vi.resetModules()
  mod = await import('./watcher')
  workspaceA = await makeWorkspace('fp-watcher-a-')
  workspaceB = await makeWorkspace('fp-watcher-b-')
})

afterEach(async () => {
  await mod.stopWatcher()
  await rm(workspaceA, { recursive: true, force: true })
  await rm(workspaceB, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('watcher lifecycle (REQ-0104 CA-08/CA-09)', () => {
  it('CA-08: no event from the old workspace is delivered after a switch', async () => {
    await mod.startWatcher(workspaceA)
    await mod.startWatcher(workspaceB)
    send.mockClear()

    // A structural change in A's tree (a new request file) must produce no
    // broadcast at all — a stale watcher on A would fire `filesystem:changed`.
    await writeFile(join(workspaceA, 'requests', 'ping.http'), 'GET https://example.com\n')
    await waitFor(() => send.mock.calls.length > 0, 800)

    expect(send).not.toHaveBeenCalled()
  })

  it('CA-09: rapid successive switches settle on exactly one active watcher, on the last workspace', async () => {
    await mod.startWatcher(workspaceA)
    await mod.startWatcher(workspaceB)
    await mod.startWatcher(workspaceA)
    await mod.startWatcher(workspaceB)
    // Let chokidar's initial scan on the final (B) watcher settle before
    // writing — this is test-side slack for the watcher's own startup
    // latency, unrelated to the shutdown race this case actually verifies.
    await new Promise((resolve) => setTimeout(resolve, 300))
    send.mockClear()

    // A change in B (the final, active workspace) produces exactly one
    // `filesystem:changed` broadcast — two would mean two watchers are alive.
    await writeFile(join(workspaceB, 'requests', 'ping.http'), 'GET https://example.com\n')
    await waitFor(() => send.mock.calls.length > 0, 2000)

    const treeChangedCalls = send.mock.calls.filter(([channel]) => channel === 'filesystem:changed')
    expect(treeChangedCalls).toHaveLength(1)

    // And a stale write into A still produces nothing.
    send.mockClear()
    await writeFile(join(workspaceA, 'requests', 'other.http'), 'GET https://example.com\n')
    await waitFor(() => send.mock.calls.length > 0, 800)
    expect(send).not.toHaveBeenCalled()
  })
})
