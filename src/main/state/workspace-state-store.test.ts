import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  _resetForTests,
  clearWorkspace,
  flushSync,
  getView,
  getWorkspaceAppearanceRaw,
  hasActiveWorkspace,
  loadFromWorkspace,
  setActiveEnvironment,
  setSession,
  setWorkspaceAppearance
} from './workspace-state-store'
import type { WorkspaceSessionTab } from '../../shared/types'

const FILE_REL = join('.fetchpier', '.state', 'workspace-state.json')

function statePath(ws: string): string {
  return join(ws, FILE_REL)
}

function writeRequestFile(ws: string, relPath: string): string {
  const full = join(ws, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, 'GET https://example.com/\n', 'utf-8')
  return full
}

function seedState(ws: string, payload: unknown): void {
  const file = statePath(ws)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(payload), 'utf-8')
}

function readState(ws: string): {
  schemaVersion: number
  activeEnvironmentId: string | null
  session: { tabs: WorkspaceSessionTab[]; activeTabIndex: number }
} {
  return JSON.parse(readFileSync(statePath(ws), 'utf-8'))
}

/** Tabs as the renderer sends them: absolute paths. */
function abs(ws: string, rel: string): WorkspaceSessionTab {
  return { kind: 'request', path: join(ws, rel) }
}

describe('workspace-state-store', () => {
  let ws: string

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ws-state-'))
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
    rmSync(ws, { recursive: true, force: true })
  })

  it('returns empty defaults when no workspace is active', () => {
    expect(getView()).toEqual({
      activeEnvironmentId: null,
      session: { tabs: [], activeTabIndex: -1 }
    })
  })

  it('first open with no state file lands on empty defaults', async () => {
    await loadFromWorkspace(ws)
    expect(getView()).toEqual({
      activeEnvironmentId: null,
      session: { tabs: [], activeTabIndex: -1 }
    })
  })

  it('round-trips a session (relative on disk, absolute in the view)', async () => {
    writeRequestFile(ws, 'requests/a.http')
    writeRequestFile(ws, 'requests/b.http')
    await loadFromWorkspace(ws)

    setSession([abs(ws, 'requests/a.http'), abs(ws, 'requests/b.http')], 1)
    setActiveEnvironment('env-dev')
    flushSync()

    const onDisk = readState(ws)
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.activeEnvironmentId).toBe('env-dev')
    expect(onDisk.session.tabs).toEqual([
      { kind: 'request', path: 'requests/a.http' },
      { kind: 'request', path: 'requests/b.http' }
    ])
    expect(onDisk.session.activeTabIndex).toBe(1)

    // Re-load and confirm the view exposes absolute paths.
    await loadFromWorkspace(ws)
    const view = getView()
    expect(view.activeEnvironmentId).toBe('env-dev')
    expect(view.session.activeTabIndex).toBe(1)
    expect(view.session.tabs.map((t) => t.path)).toEqual([
      join(ws, 'requests/a.http'),
      join(ws, 'requests/b.http')
    ])
  })

  it('empty session round-trips to empty (tabs [], activeTabIndex -1)', async () => {
    writeRequestFile(ws, 'requests/a.http')
    await loadFromWorkspace(ws)
    setSession([abs(ws, 'requests/a.http')], 0)
    flushSync()

    setSession([], -1)
    flushSync()
    expect(readState(ws).session).toEqual({ tabs: [], activeTabIndex: -1 })

    await loadFromWorkspace(ws)
    expect(getView().session).toEqual({ tabs: [], activeTabIndex: -1 })
  })

  it('drops entries with an unknown kind on load and on rewrite', async () => {
    writeRequestFile(ws, 'requests/a.http')
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: {
        tabs: [
          { kind: 'request', path: 'requests/a.http' },
          { kind: 'mock-server', path: 'requests/a.http' }
        ],
        activeTabIndex: 0
      }
    })
    await loadFromWorkspace(ws)
    expect(getView().session.tabs).toHaveLength(1)
    expect(getView().session.tabs[0].path).toBe(join(ws, 'requests/a.http'))

    // The load scheduled a cleanup write; flush and confirm the unknown kind is gone.
    flushSync()
    expect(readState(ws).session.tabs).toEqual([{ kind: 'request', path: 'requests/a.http' }])
  })

  it('ignores path-traversal and absolute entries on load', async () => {
    writeRequestFile(ws, 'requests/a.http')
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: {
        tabs: [
          { kind: 'request', path: '../escape.http' },
          { kind: 'request', path: '/etc/passwd' },
          { kind: 'request', path: 'requests/a.http' }
        ],
        activeTabIndex: 0
      }
    })
    await loadFromWorkspace(ws)
    const view = getView()
    expect(view.session.tabs).toEqual([{ kind: 'request', path: join(ws, 'requests/a.http') }])
  })

  it('ignores tabs whose backing file no longer exists', async () => {
    writeRequestFile(ws, 'requests/keep.http')
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: {
        tabs: [
          { kind: 'request', path: 'requests/gone.http' },
          { kind: 'request', path: 'requests/keep.http' }
        ],
        activeTabIndex: 1
      }
    })
    await loadFromWorkspace(ws)
    const view = getView()
    expect(view.session.tabs).toEqual([{ kind: 'request', path: join(ws, 'requests/keep.http') }])
    // The active tab (index 1 → 'keep') survived by identity.
    expect(view.session.activeTabIndex).toBe(0)
  })

  it('clamps an out-of-range activeTabIndex to the last restorable tab', async () => {
    writeRequestFile(ws, 'requests/a.http')
    writeRequestFile(ws, 'requests/b.http')
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: {
        tabs: [
          { kind: 'request', path: 'requests/a.http' },
          { kind: 'request', path: 'requests/b.http' }
        ],
        activeTabIndex: 9
      }
    })
    await loadFromWorkspace(ws)
    expect(getView().session.activeTabIndex).toBe(1)
  })

  it('treats a corrupt file as no state (empty defaults)', async () => {
    mkdirSync(dirname(statePath(ws)), { recursive: true })
    writeFileSync(statePath(ws), '{ not valid json', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadFromWorkspace(ws)
    expect(getView()).toEqual({
      activeEnvironmentId: null,
      session: { tabs: [], activeTabIndex: -1 }
    })
    warn.mockRestore()
  })

  it('drops absolute tabs that fall outside the workspace on write', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ws-other-'))
    try {
      writeRequestFile(ws, 'requests/a.http')
      await loadFromWorkspace(ws)
      setSession(
        [{ kind: 'request', path: join(other, 'requests/x.http') }, abs(ws, 'requests/a.http')],
        0
      )
      flushSync()
      const onDisk = readState(ws)
      expect(onDisk.session.tabs).toEqual([{ kind: 'request', path: 'requests/a.http' }])
      // Active pointed at the dropped entry (index 0) → clamps to the survivor.
      expect(onDisk.session.activeTabIndex).toBe(0)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('writes are atomic — no leftover .tmp file', async () => {
    writeRequestFile(ws, 'requests/a.http')
    await loadFromWorkspace(ws)
    setSession([abs(ws, 'requests/a.http')], 0)
    flushSync()
    const entries = await fs.readdir(join(ws, '.fetchpier', '.state'))
    expect(entries).toContain('workspace-state.json')
    expect(entries.every((e) => !e.endsWith('.tmp'))).toBe(true)
  })

  it('flushSync is a no-op when no write is pending', async () => {
    await loadFromWorkspace(ws)
    flushSync()
    await expect(fs.access(statePath(ws))).rejects.toBeTruthy()
  })

  it('switching workspaces flushes the previous one', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-state-a-'))
    const b = mkdtempSync(join(tmpdir(), 'ws-state-b-'))
    try {
      writeRequestFile(a, 'requests/a.http')
      await loadFromWorkspace(a)
      setSession([{ kind: 'request', path: join(a, 'requests/a.http') }], 0)

      await loadFromWorkspace(b) // should flush `a`
      const onDiskA = readState(a)
      expect(onDiskA.session.tabs).toEqual([{ kind: 'request', path: 'requests/a.http' }])
      expect(getView().session.tabs).toEqual([])
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('reloading the open workspace keeps a change still waiting for its debounced write (HIS-05)', async () => {
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: 'old',
      session: { tabs: [], activeTabIndex: -1 }
    })
    await loadFromWorkspace(ws)
    setActiveEnvironment('new-env')

    await loadFromWorkspace(ws)
    expect(getView().activeEnvironmentId).toBe('new-env')
    flushSync()
    expect(readState(ws).activeEnvironmentId).toBe('new-env')
  })

  // ── Tab mode marker (preview / pinned) ─────────────────────────────────────

  it('round-trips the preview mode (relative on disk, present in the view)', async () => {
    writeRequestFile(ws, 'requests/a.http')
    writeRequestFile(ws, 'requests/b.http')
    await loadFromWorkspace(ws)

    setSession(
      [
        abs(ws, 'requests/a.http'),
        { kind: 'request', path: join(ws, 'requests/b.http'), mode: 'preview' }
      ],
      0
    )
    flushSync()

    const onDisk = readState(ws)
    expect(onDisk.session.tabs).toEqual([
      { kind: 'request', path: 'requests/a.http' },
      { kind: 'request', path: 'requests/b.http', mode: 'preview' }
    ])

    await loadFromWorkspace(ws)
    const view = getView()
    expect(view.session.tabs[0].mode).toBeUndefined()
    expect(view.session.tabs[1].mode).toBe('preview')
  })

  it('round-trips the pinned mode across a workspace reopen', async () => {
    // Regression: a pinned tab used to lose its pin after close + reopen because
    // the main store dropped the marker at every stage.
    writeRequestFile(ws, 'requests/a.http')
    await loadFromWorkspace(ws)

    setSession([{ kind: 'request', path: join(ws, 'requests/a.http'), mode: 'pinned' }], 0)
    flushSync()

    expect(readState(ws).session.tabs).toEqual([
      { kind: 'request', path: 'requests/a.http', mode: 'pinned' }
    ])

    await loadFromWorkspace(ws)
    expect(getView().session.tabs[0].mode).toBe('pinned')
  })

  it('reads the legacy preview:true marker as the preview mode (back-compat)', async () => {
    writeRequestFile(ws, 'requests/a.http')
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: {
        // A session written before the mode enum existed (REQ-0085 format).
        tabs: [{ kind: 'request', path: 'requests/a.http', preview: true }],
        activeTabIndex: 0
      }
    })
    await loadFromWorkspace(ws)
    expect(getView().session.tabs[0].mode).toBe('preview')
  })

  it('reads a missing mode field as permanent (no marker in the view)', async () => {
    writeRequestFile(ws, 'requests/a.http')
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: {
        tabs: [{ kind: 'request', path: 'requests/a.http' }],
        activeTabIndex: 0
      }
    })
    await loadFromWorkspace(ws)
    expect(getView().session.tabs[0].mode).toBeUndefined()
  })

  it('ignores an unknown mode value on load', async () => {
    writeRequestFile(ws, 'requests/a.http')
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: {
        tabs: [{ kind: 'request', path: 'requests/a.http', mode: 'bogus' }],
        activeTabIndex: 0
      }
    })
    await loadFromWorkspace(ws)
    expect(getView().session.tabs[0].mode).toBeUndefined()
  })

  it('clearWorkspace flushes then detaches', async () => {
    writeRequestFile(ws, 'requests/a.http')
    await loadFromWorkspace(ws)
    setActiveEnvironment('env-x')
    clearWorkspace()
    expect(readState(ws).activeEnvironmentId).toBe('env-x')
    expect(getView().activeEnvironmentId).toBeNull()
  })
})

// Requirement *Workspace color palettes* §5.3, §6.6: the store keeps the
// workspace's palette block exactly as it found it — it never interprets it —
// and replaces it only on an explicit appearance write, which is immediate and
// reports failure.
describe('workspace-state-store — appearance block', () => {
  let ws: string
  const block = {
    schemaVersion: 1,
    light: { selected: 'inherit' },
    dark: { selected: 'forest' }
  }
  const raw = (): unknown =>
    (readState(ws) as unknown as Record<string, unknown>).appearancePalettes

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ws-appearance-'))
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
    rmSync(ws, { recursive: true, force: true })
  })

  it('reports no block and writes nothing when the file has none (CA-01)', async () => {
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: { tabs: [], activeTabIndex: -1 }
    })
    const before = readFileSync(statePath(ws), 'utf-8')
    await loadFromWorkspace(ws)
    expect(hasActiveWorkspace()).toBe(true)
    expect(getWorkspaceAppearanceRaw()).toBeUndefined()
    await new Promise((r) => setTimeout(r, 300))
    expect(readFileSync(statePath(ws), 'utf-8')).toBe(before)
  })

  it('keeps the block through session and active-environment writes (CA-05)', async () => {
    writeRequestFile(ws, 'requests/a.http')
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: { tabs: [], activeTabIndex: -1 },
      appearancePalettes: block
    })
    await loadFromWorkspace(ws)
    expect(getWorkspaceAppearanceRaw()).toEqual(block)
    setSession([abs(ws, 'requests/a.http')], 0)
    setActiveEnvironment('env-y')
    flushSync()
    expect(raw()).toEqual(block)
    expect(readState(ws).activeEnvironmentId).toBe('env-y')
  })

  it.each([
    ['a newer version (CA-04)', { schemaVersion: 2, light: { selected: 'aurora' }, accent: 'x' }],
    ['invalid content', { schemaVersion: 1, light: { selected: 42 }, dark: 'forest' }],
    ['a non-object value', 'forest']
  ])('writes %s back unchanged', async (_label, value) => {
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: { tabs: [], activeTabIndex: -1 },
      appearancePalettes: value
    })
    await loadFromWorkspace(ws)
    setActiveEnvironment('env-z')
    flushSync()
    expect(raw()).toEqual(value)
  })

  it('writes an appearance change at once, together with the rest of the state', async () => {
    writeRequestFile(ws, 'requests/a.http')
    await loadFromWorkspace(ws)
    setSession([abs(ws, 'requests/a.http')], 0)
    await setWorkspaceAppearance(block)
    expect(raw()).toEqual(block)
    expect(readState(ws).session.tabs).toHaveLength(1)
    expect(getWorkspaceAppearanceRaw()).toEqual(block)
  })

  it('rejects an appearance write with no workspace open (CA-06)', async () => {
    expect(hasActiveWorkspace()).toBe(false)
    await expect(setWorkspaceAppearance(block)).rejects.toThrow(/workspace/i)
  })

  it('reports a failed appearance write and keeps the previous block (CA-07)', async () => {
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: { tabs: [], activeTabIndex: -1 },
      appearancePalettes: block
    })
    await loadFromWorkspace(ws)
    // The target becomes a directory: the atomic rename onto it fails.
    rmSync(statePath(ws))
    mkdirSync(statePath(ws))
    await expect(
      setWorkspaceAppearance({
        schemaVersion: 1,
        light: { selected: 'paper' },
        dark: { selected: 'inherit' }
      })
    ).rejects.toThrow()
    expect(getWorkspaceAppearanceRaw()).toEqual(block)
  })

  it('forgets the block when the workspace closes', async () => {
    seedState(ws, {
      schemaVersion: 1,
      activeEnvironmentId: null,
      session: { tabs: [], activeTabIndex: -1 },
      appearancePalettes: block
    })
    await loadFromWorkspace(ws)
    clearWorkspace()
    expect(hasActiveWorkspace()).toBe(false)
    expect(getWorkspaceAppearanceRaw()).toBeUndefined()
  })
})
