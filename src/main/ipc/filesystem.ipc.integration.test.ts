/**
 * Integration: request-instance cascade — ON-DISK end state over a real tmpdir.
 *
 * The sibling *derivation* logic (which files cascade, and to what names) is pure
 * and proven at unit level — `request-instances.ts`, `core/workspace/tree.ts`, and
 * the branch/negative coverage in `filesystem.ipc.test.ts` (mocked fs). This spec
 * proves only what those cannot: that the real handlers actually propagate the
 * change on a real filesystem. It deliberately does NOT re-assert the derivation
 * (no manifest/op-count checks) — just the resulting file layout on disk.
 *
 * Covers the lowered cascade cases: rename / move / delete a parent request, and
 * create-instance writing a fresh `@id` (catalog: INSTANCE rename/move/delete +
 * create, integration level).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Capture ipcMain.handle registrations (the only Electron seam) ──────────────
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  }
}))

// Active workspace points at a per-test tmpdir. `state` is hoisted so the mock
// factory can read it; `beforeEach` swaps in a fresh root for every test. The
// handlers now resolve the workspace handle (F6): the mock returns a real handle
// over the tmpdir, exercising `core.workspace` tree mutations end-to-end.
const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../state/active-workspace', async () => {
  const { workspace } = await import('@fetchpier/core')
  return {
    requireActiveWorkspaceHandle: () => workspace.openWorkspace(state.root)
  }
})

// Real fs, real node:crypto, real safe-path — only the two seams above are mocked.
const { registerFilesystemHandlers } = await import('./filesystem.ipc')
registerFilesystemHandlers()

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} handler not registered`)
  return handler({}, ...args)
}

/** Absolute path inside the active tmpdir workspace. */
const p = (...segments: string[]): string => join(state.root, ...segments)

/** Seed a real file on disk, creating parent directories. */
async function seed(rel: string, content = 'GET https://example.com\n'): Promise<void> {
  const full = p(rel)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}

/** Whether a workspace-relative path exists on disk. */
function exists(rel: string): Promise<boolean> {
  return fs
    .access(p(rel))
    .then(() => true)
    .catch(() => false)
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'fp-fsipc-'))
})
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
})

describe('fs:rename — on-disk cascade', () => {
  it('renames the parent and its instance siblings on disk', async () => {
    await seed('requests/auth/login.http')
    await seed('requests/auth/login.ok.instance.http')

    await invoke('fs:rename', p('requests', 'auth', 'login.http'), 'auth-login.http')

    expect(await exists('requests/auth/auth-login.http')).toBe(true)
    expect(await exists('requests/auth/auth-login.ok.instance.http')).toBe(true)
    expect(await exists('requests/auth/login.http')).toBe(false)
    expect(await exists('requests/auth/login.ok.instance.http')).toBe(false)
  })
})

describe('fs:move — on-disk cascade', () => {
  it('moves the parent and its instance siblings to the target folder on disk', async () => {
    await seed('requests/auth/login.http')
    await seed('requests/auth/login.ok.instance.http')
    await fs.mkdir(p('requests', 'users'), { recursive: true })

    await invoke('fs:move', p('requests', 'auth', 'login.http'), p('requests', 'users'))

    expect(await exists('requests/users/login.http')).toBe(true)
    expect(await exists('requests/users/login.ok.instance.http')).toBe(true)
    expect(await exists('requests/auth/login.http')).toBe(false)
    expect(await exists('requests/auth/login.ok.instance.http')).toBe(false)
  })
})

describe('fs:delete — on-disk cascade', () => {
  it('deletes the parent and its instance siblings on disk', async () => {
    await seed('requests/auth/login.http')
    await seed('requests/auth/login.ok.instance.http')

    await invoke('fs:delete', p('requests', 'auth', 'login.http'))

    expect(await exists('requests/auth/login.http')).toBe(false)
    expect(await exists('requests/auth/login.ok.instance.http')).toBe(false)
  })
})

describe('fs:checkName — verdict through the boundary', () => {
  // The rule itself is unit-proven in core/workspace/tree-mutations; this only
  // proves the channel → handle → core wiring answers over a real workspace.
  it('answers taken/available against the real disk state', async () => {
    await seed('requests/orders.http')

    expect(
      await invoke('fs:checkName', { kind: 'entry', parentPath: p('requests'), name: 'Orders' })
    ).toEqual({ available: false, conflict: 'request' })
    expect(
      await invoke('fs:checkName', { kind: 'entry', parentPath: p('requests'), name: 'fresh' })
    ).toEqual({ available: true })
  })
})

describe('fs:createInstance — on-disk clone', () => {
  it('writes the instance file with a fresh @id different from the parent', async () => {
    await seed('requests/auth/login.http', '# @id parent-uuid\nGET https://example.com\n')

    await invoke('fs:createInstance', p('requests', 'auth', 'login.http'), 'happy-path')

    expect(await exists('requests/auth/login.happy-path.instance.http')).toBe(true)
    const written = await fs.readFile(
      p('requests', 'auth', 'login.happy-path.instance.http'),
      'utf-8'
    )
    const id = written.match(/# @id (\S+)/)?.[1]
    expect(id).toBeDefined()
    expect(id).not.toBe('parent-uuid')
  })
})
