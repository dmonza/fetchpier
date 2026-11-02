import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeRequest } from '@shared/lib/http-serializer'
import { hashString } from '@shared/lib/hash'

let store: typeof import('./request').useRequestStore

// crypto.randomUUID is used inside createTab; jsdom provides it but pin the
// return value for determinism.
const uuidMock = vi.fn(() => '00000000-0000-0000-0000-000000000000')

beforeEach(async () => {
  vi.resetModules()
  // REQ-0095: the store schedules a debounced reconcile via setTimeout. Fake only
  // the timer functions so the immediate (optimistic) dirty set is observable
  // synchronously and the reconcile can be driven explicitly with advanceTimersByTime.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: uuidMock })
  const mod = await import('./request')
  store = mod.useRequestStore
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  uuidMock.mockClear()
})

describe('request store — initial state', () => {
  // REQ-0084: no one-tab floor — the app starts with zero tabs (empty state).
  it('starts with no tabs and no active tab', () => {
    const s = store.getState()
    expect(s.tabs).toHaveLength(0)
    expect(s.activeTabId).toBeNull()
  })
})

describe('openTab', () => {
  it('appends a new tab and makes it active', () => {
    store.getState().openTab({ title: 'B' })
    const s = store.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.activeTabId).toBe(s.tabs[0].id)
    expect(s.tabs[0].title).toBe('B')
  })

  it('activates an existing tab when filePath matches', () => {
    store.getState().openTab({ title: 'X', filePath: '/ws/a.http' })
    const idAfterFirst = store.getState().activeTabId
    store.getState().openTab({ title: 'New name', filePath: '/ws/a.http' })
    const s = store.getState()
    expect(s.tabs).toHaveLength(1) // second openTab is a no-op (same filePath)
    expect(s.activeTabId).toBe(idAfterFirst)
  })

  it('activates an existing tab when historyEntryId matches', () => {
    store.getState().openTab({ title: 'h1', historyEntryId: 'hist-1' })
    const id = store.getState().activeTabId
    store.getState().openTab({ title: 'h1-again', historyEntryId: 'hist-1' })
    expect(store.getState().tabs).toHaveLength(1)
    expect(store.getState().activeTabId).toBe(id)
  })
})

describe('closeTab', () => {
  it('removes the tab and falls back to a sibling', () => {
    store.getState().openTab({ title: 'A' })
    store.getState().openTab({ title: 'B' })
    store.getState().openTab({ title: 'C' })
    const s = store.getState()
    expect(s.tabs).toHaveLength(3)
    const middle = s.tabs[1].id
    store.getState().closeTab(middle)
    expect(store.getState().tabs.map((t) => t.title)).toEqual(['A', 'C'])
  })

  it('closing the last tab reaches the empty state (no untitled spawned)', () => {
    store.getState().openTab({ title: 'only' })
    const onlyTabId = store.getState().tabs[0].id
    store.getState().closeTab(onlyTabId)
    const s = store.getState()
    expect(s.tabs).toHaveLength(0)
    expect(s.activeTabId).toBeNull()
  })

  it('is a no-op when the id does not exist', () => {
    store.getState().openTab({ title: 'A' })
    const before = store.getState()
    store.getState().closeTab('does-not-exist')
    const after = store.getState()
    expect(after.tabs).toBe(before.tabs)
    expect(after.activeTabId).toBe(before.activeTabId)
  })

  it('keeps activeTabId unchanged when closing a non-active tab', () => {
    store.getState().openTab({ title: 'A' })
    store.getState().openTab({ title: 'B' })
    const activeBefore = store.getState().activeTabId
    const otherId = store.getState().tabs.find((t) => t.id !== activeBefore)!.id
    store.getState().closeTab(otherId)
    expect(store.getState().activeTabId).toBe(activeBefore)
  })
})

describe('closeOtherTabs', () => {
  it('keeps only the requested tab', () => {
    store.getState().openTab({ title: 'B' })
    store.getState().openTab({ title: 'C' })
    const keep = store.getState().tabs[1].id
    store.getState().closeOtherTabs(keep)
    const s = store.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].id).toBe(keep)
    expect(s.activeTabId).toBe(keep)
  })

  it('is a no-op when the id does not exist', () => {
    store.getState().openTab({ title: 'B' })
    const before = store.getState().tabs
    store.getState().closeOtherTabs('nope')
    expect(store.getState().tabs).toBe(before)
  })
})

describe('closeAllTabs', () => {
  it('drops everything and reaches the empty state', () => {
    store.getState().openTab({ title: 'A' })
    store.getState().openTab({ title: 'B' })
    store.getState().closeAllTabs()
    const s = store.getState()
    expect(s.tabs).toHaveLength(0)
    expect(s.activeTabId).toBeNull()
  })
})

describe('restoreSession', () => {
  it('rebuilds file-backed tabs in order with the indexed tab active', () => {
    store
      .getState()
      .restoreSession([{ path: '/ws/requests/a.http' }, { path: '/ws/requests/sub/b.http' }], 1)
    const s = store.getState()
    expect(s.tabs).toHaveLength(2)
    expect(s.tabs.map((t) => t.filePath)).toEqual([
      '/ws/requests/a.http',
      '/ws/requests/sub/b.http'
    ])
    // Title is the basename without the .http extension.
    expect(s.tabs.map((t) => t.title)).toEqual(['a', 'b'])
    expect(s.activeTabId).toBe(s.tabs[1].id)
  })

  it('an empty session restores the empty state', () => {
    store.getState().openTab({ title: 'leftover' })
    store.getState().restoreSession([], -1)
    const s = store.getState()
    expect(s.tabs).toHaveLength(0)
    expect(s.activeTabId).toBeNull()
  })

  it('leaves no active tab when activeIndex is out of range', () => {
    store.getState().restoreSession([{ path: '/ws/requests/a.http' }], 5)
    expect(store.getState().activeTabId).toBeNull()
  })

  it('replaces any pre-existing tabs wholesale', () => {
    store.getState().openTab({ title: 'old', filePath: '/ws/old.http' })
    store.getState().restoreSession([{ path: '/ws/requests/new.http' }], 0)
    const s = store.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].filePath).toBe('/ws/requests/new.http')
  })
})

describe('reorderTabs', () => {
  it('moves a tab from one position to another', () => {
    store.getState().openTab({ title: 'A' })
    store.getState().openTab({ title: 'B' })
    store.getState().openTab({ title: 'C' })
    const [a, b, c] = store.getState().tabs.map((t) => t.id)
    store.getState().reorderTabs(c, a)
    expect(store.getState().tabs.map((t) => t.id)).toEqual([c, a, b])
  })

  it('is a no-op when fromId equals toId', () => {
    store.getState().openTab({ title: 'A' })
    const before = store.getState().tabs
    store.getState().reorderTabs(before[0].id, before[0].id)
    expect(store.getState().tabs).toBe(before)
  })

  it('is a no-op when either id is unknown', () => {
    store.getState().openTab({ title: 'B' })
    const before = store.getState().tabs
    store.getState().reorderTabs('unknown', before[0].id)
    expect(store.getState().tabs).toBe(before)
  })
})

describe('setActiveTab and updateTab', () => {
  it('setActiveTab points at the requested id (no existence check)', () => {
    store.getState().setActiveTab('arbitrary')
    expect(store.getState().activeTabId).toBe('arbitrary')
  })

  it('updateTab patches only the matching tab', () => {
    store.getState().openTab({ title: 'A' })
    store.getState().openTab({ title: 'B' })
    const [first, second] = store.getState().tabs.map((t) => t.id)
    store.getState().updateTab(second, { title: 'B!', isLoading: true })
    const s = store.getState()
    expect(s.tabs.find((t) => t.id === first)?.title).toBe('A')
    expect(s.tabs.find((t) => t.id === second)?.title).toBe('B!')
    expect(s.tabs.find((t) => t.id === second)?.isLoading).toBe(true)
  })
})

describe('updateTab — UI-state fields do not flip isDirty', () => {
  // REQ-0064: switching the active sub-tab, response sub-tab, or script phase is
  // pure UI state. It must NOT mark the tab as dirty (no asterisk in the title).
  beforeEach(() => {
    store.getState().openTab()
  })

  it('activeReqTab does not set isDirty', () => {
    const id = store.getState().tabs[0].id
    expect(store.getState().tabs[0].isDirty).toBe(false)
    store.getState().updateTab(id, { activeReqTab: 'body' })
    expect(store.getState().tabs[0].activeReqTab).toBe('body')
    expect(store.getState().tabs[0].isDirty).toBe(false)
  })

  it('activeResponseTab does not set isDirty', () => {
    const id = store.getState().tabs[0].id
    store.getState().updateTab(id, { activeResponseTab: 'headers' })
    expect(store.getState().tabs[0].activeResponseTab).toBe('headers')
    expect(store.getState().tabs[0].isDirty).toBe(false)
  })

  it('activeScriptPhase does not set isDirty', () => {
    const id = store.getState().tabs[0].id
    store.getState().updateTab(id, { activeScriptPhase: 'post' })
    expect(store.getState().tabs[0].activeScriptPhase).toBe('post')
    expect(store.getState().tabs[0].isDirty).toBe(false)
  })

  it('preserves an already-dirty flag when patching UI-state fields', () => {
    const id = store.getState().tabs[0].id
    store.getState().updateRequest(id, { method: 'POST' })
    expect(store.getState().tabs[0].isDirty).toBe(true)
    store.getState().updateTab(id, { activeReqTab: 'body' })
    expect(store.getState().tabs[0].isDirty).toBe(true)
  })
})

describe('updateRequest — dirty tracking', () => {
  beforeEach(() => {
    store.getState().openTab()
  })

  it('merges the request partial and sets isDirty=true', () => {
    const id = store.getState().tabs[0].id
    expect(store.getState().tabs[0].isDirty).toBe(false)
    store.getState().updateRequest(id, { method: 'POST' })
    const tab = store.getState().tabs[0]
    expect(tab.request.method).toBe('POST')
    expect(tab.isDirty).toBe(true)
  })

  it('preserves untouched request fields when merging a partial', () => {
    const id = store.getState().tabs[0].id
    const originalUrl = store.getState().tabs[0].request.url
    store.getState().updateRequest(id, { method: 'PUT' })
    expect(store.getState().tabs[0].request.url).toBe(originalUrl)
  })

  it('ignores updates targeted at a non-existent tab', () => {
    const before = store.getState().tabs
    store.getState().updateRequest('does-not-exist', { method: 'DELETE' })
    expect(store.getState().tabs).toEqual(before)
  })
})

// ── Preview tabs (REQ-0085) ──────────────────────────────────────────────────

describe('openPreviewTab — single-click preview', () => {
  it('creates one preview tab and makes it active (CA-06)', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const s = store.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].mode).toBe('preview')
    expect(s.tabs[0].filePath).toBe('/ws/a.http')
    expect(s.activeTabId).toBe(s.tabs[0].id)
  })

  it('replaces the prior preview in place at the same index (CA-01)', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const firstId = store.getState().tabs[0].id
    store.getState().openPreviewTab({ title: 'B', filePath: '/ws/b.http' })
    const s = store.getState()
    // Exactly one preview tab, still at index 0, now showing B.
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].filePath).toBe('/ws/b.http')
    expect(s.tabs[0].mode).toBe('preview')
    // Fresh tab id so the editor re-parses the newly-shown file.
    expect(s.tabs[0].id).not.toBe(firstId)
    expect(s.activeTabId).toBe(s.tabs[0].id)
  })

  it('keeps a permanent tab to the left when replacing the preview in place', () => {
    store.getState().openTab({ title: 'P', filePath: '/ws/p.http' }) // permanent, index 0
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' }) // preview, index 1
    store.getState().openPreviewTab({ title: 'B', filePath: '/ws/b.http' }) // replaces index 1
    const s = store.getState()
    expect(s.tabs.map((t) => t.filePath)).toEqual(['/ws/p.http', '/ws/b.http'])
    expect(s.tabs[0].mode).not.toBe('preview')
    expect(s.tabs[1].mode).toBe('preview')
  })

  it('focuses an existing permanent tab without creating a preview (CA-05)', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    const permanentId = store.getState().tabs[0].id
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const s = store.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].mode).not.toBe('preview')
    expect(s.activeTabId).toBe(permanentId)
  })

  it('re-clicking the current preview just keeps it focused (no new tab)', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const previewId = store.getState().tabs[0].id
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const s = store.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].id).toBe(previewId)
    expect(s.activeTabId).toBe(previewId)
  })

  it('never keeps more than one preview while browsing (CA-06)', () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      store.getState().openPreviewTab({ title: name, filePath: `/ws/${name}.http` })
    }
    const s = store.getState()
    expect(s.tabs.filter((t) => t.mode === 'preview')).toHaveLength(1)
    expect(s.tabs).toHaveLength(1)
  })
})

describe('promoteTab — promotion to permanent', () => {
  it('drops the preview flag (CA-03)', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const id = store.getState().tabs[0].id
    store.getState().promoteTab(id)
    expect(store.getState().tabs[0].mode).toBe('permanent')
  })

  it('is a no-op on an already-permanent tab', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    const before = store.getState().tabs
    store.getState().promoteTab(before[0].id)
    expect(store.getState().tabs).toBe(before)
  })

  it('promoting frees the slot so the next single click creates a fresh preview', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().promoteTab(store.getState().tabs[0].id)
    store.getState().openPreviewTab({ title: 'B', filePath: '/ws/b.http' })
    const s = store.getState()
    expect(s.tabs.map((t) => t.filePath)).toEqual(['/ws/a.http', '/ws/b.http'])
    expect(s.tabs[0].mode).toBe('permanent')
    expect(s.tabs[1].mode).toBe('preview')
  })
})

describe('editing promotes a preview tab (CA-04)', () => {
  it('updateRequest dirties and promotes in one step', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const id = store.getState().tabs[0].id
    store.getState().updateRequest(id, { method: 'POST' })
    const tab = store.getState().tabs[0]
    expect(tab.isDirty).toBe(true)
    expect(tab.mode).toBe('permanent')
  })

  it('updateTab with isDirty:true promotes; a non-dirty patch does not', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const id = store.getState().tabs[0].id
    // A pure UI-state patch keeps the preview.
    store.getState().updateTab(id, { activeReqTab: 'body' })
    expect(store.getState().tabs[0].mode).toBe('preview')
    // A dirtying patch promotes it.
    store.getState().updateTab(id, { isDirty: true })
    expect(store.getState().tabs[0].mode).toBe('permanent')
  })

  it('a tab is never both dirty and preview (invariant)', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const id = store.getState().tabs[0].id
    store.getState().updateRequest(id, { url: 'https://x' })
    expect(store.getState().tabs.some((t) => t.isDirty && t.mode === 'preview')).toBe(false)
  })
})

// ── Computed (non-sticky) dirty state (REQ-0095) ─────────────────────────────

describe('computed dirty state', () => {
  it('a new untitled tab seeds a clean baseline and is not dirty', () => {
    store.getState().openTab()
    const tab = store.getState().tabs[0]
    expect(tab.cleanHash).toBeDefined()
    expect(tab.isDirty).toBe(false)
  })

  it('an edit sets isDirty immediately (before any reconcile)', () => {
    store.getState().openTab()
    const id = store.getState().tabs[0].id
    store.getState().updateRequest(id, { url: 'https://x' })
    // No timer advance — the optimistic set must already be visible.
    expect(store.getState().tabs[0].isDirty).toBe(true)
  })

  it('reverting an edit back to the baseline clears isDirty after the reconcile', () => {
    store.getState().openTab()
    const id = store.getState().tabs[0].id
    store.getState().updateRequest(id, { url: 'https://x' })
    vi.advanceTimersByTime(400)
    expect(store.getState().tabs[0].isDirty).toBe(true) // genuinely changed
    // Revert to the default url ('') — back to the seeded baseline.
    store.getState().updateRequest(id, { url: '' })
    expect(store.getState().tabs[0].isDirty).toBe(true) // optimistic
    vi.advanceTimersByTime(400)
    expect(store.getState().tabs[0].isDirty).toBe(false) // reconciled clean
  })

  it('a genuine change stays dirty after the reconcile', () => {
    store.getState().openTab()
    const id = store.getState().tabs[0].id
    store.getState().updateRequest(id, { method: 'POST' })
    vi.advanceTimersByTime(400)
    expect(store.getState().tabs[0].isDirty).toBe(true)
  })

  it('markClean recaptures the baseline and clears isDirty', () => {
    store.getState().openTab()
    const id = store.getState().tabs[0].id
    store.getState().updateRequest(id, { url: 'https://x' })
    expect(store.getState().tabs[0].isDirty).toBe(true)
    store.getState().markClean(id)
    const tab = store.getState().tabs[0]
    expect(tab.isDirty).toBe(false)
    expect(tab.cleanHash).toBeDefined()
    // A pending reconcile must not resurrect dirtiness.
    vi.advanceTimersByTime(400)
    expect(store.getState().tabs[0].isDirty).toBe(false)
  })

  it('markClean keeps the tab dirty when it holds a malformed param', () => {
    store.getState().openTab()
    const id = store.getState().tabs[0].id
    store.getState().updateTab(id, {
      request: {
        ...store.getState().tabs[0].request,
        params: [{ id: 'p1', key: 'a', value: '%', enabled: true, malformed: true }]
      }
    })
    store.getState().markClean(id)
    expect(store.getState().tabs[0].isDirty).toBe(true)
  })

  it('markClean on a malformed-loaded preview tab promotes it (never dirty+preview)', () => {
    store.getState().openPreviewTab({ title: 'A', filePath: '/ws/a.http' })
    const id = store.getState().tabs[0].id
    store.getState().updateTab(id, {
      request: {
        ...store.getState().tabs[0].request,
        params: [{ id: 'p1', key: 'a', value: '%', enabled: true, malformed: true }]
      }
    })
    store.getState().markClean(id)
    const tab = store.getState().tabs[0]
    expect(tab.isDirty).toBe(true)
    expect(tab.mode).not.toBe('preview')
  })

  it('markClean against the written baseline keeps an edit made during the save in-flight (TOCTOU)', () => {
    // Reproduces FIX-3: a save serializes+writes snapshot "A", but the user edits
    // during the async write. markClean must baseline against what was WRITTEN,
    // not against the (newer) current content — otherwise the in-flight edit is
    // silently swallowed (dirty cleared while disk holds the older content).
    store.getState().openTab()
    const tab0 = store.getState().tabs[0]
    const id = tab0.id
    const writtenHash = hashString(serializeRequest(tab0.request, tab0.requestId))
    // User types while the write is in flight:
    store.getState().updateRequest(id, { url: 'https://typed-during-await' })
    // Save completes and marks clean against what it actually wrote:
    store.getState().markClean(id, writtenHash)
    expect(store.getState().tabs[0].isDirty).toBe(true)
  })

  it('markClean with no baseline arg cleans against the current content (load path)', () => {
    store.getState().openTab()
    const id = store.getState().tabs[0].id
    store.getState().updateRequest(id, { url: 'https://x' })
    store.getState().markClean(id)
    expect(store.getState().tabs[0].isDirty).toBe(false)
  })

  it('closing a tab cancels its pending reconcile (no late state change)', () => {
    store.getState().openTab()
    store.getState().openTab()
    const [a] = store.getState().tabs.map((t) => t.id)
    store.getState().updateRequest(a, { url: 'https://x' })
    store.getState().closeTab(a)
    // Advancing past the debounce must not throw or touch the remaining tab.
    expect(() => vi.advanceTimersByTime(400)).not.toThrow()
    expect(store.getState().tabs).toHaveLength(1)
  })
})

// ── Re-point on in-app rename/move (REQ open-tab-file-reconciliation) ─────────

describe('repointTabs — open tab follows its file', () => {
  it('updates filePath + title while preserving id, dirty state and baseline', () => {
    store.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    const id = store.getState().tabs[0].id
    // Seed a baseline then dirty the tab so we can assert both survive the move.
    store.getState().markClean(id)
    const cleanHash = store.getState().tabs[0].cleanHash
    store.getState().updateRequest(id, { url: 'https://x' })
    expect(store.getState().tabs[0].isDirty).toBe(true)

    store
      .getState()
      .repointTabs([{ oldPath: '/ws/requests/a.http', newPath: '/ws/requests/sub/renamed.http' }])

    const tab = store.getState().tabs[0]
    expect(tab.id).toBe(id) // same tab id → in-memory buffer preserved
    expect(tab.filePath).toBe('/ws/requests/sub/renamed.http')
    expect(tab.title).toBe('renamed') // basename sans .http
    expect(tab.isDirty).toBe(true) // unsaved edits kept
    expect(tab.cleanHash).toBe(cleanHash) // baseline unchanged
    expect(tab.request.url).toBe('https://x') // buffer intact
  })

  it('clears removedOnDisk and conflict when a tab is re-pointed', () => {
    store.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    const id = store.getState().tabs[0].id
    store.getState().updateTab(id, { removedOnDisk: true, conflict: true })

    store
      .getState()
      .repointTabs([{ oldPath: '/ws/requests/a.http', newPath: '/ws/requests/a.http' }])

    const tab = store.getState().tabs[0]
    expect(tab.removedOnDisk).toBeFalsy()
    expect(tab.conflict).toBeFalsy()
  })

  it('re-points every tab sharing the old path (forEach, not find)', () => {
    // The store dedupes by path on the open paths, but reconciliation must be
    // resilient: re-point ALL matching tabs, never just the first.
    store.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    const original = store.getState().tabs[0]
    store.setState({
      tabs: [original, { ...original, id: 'dup-id' }]
    })

    store
      .getState()
      .repointTabs([{ oldPath: '/ws/requests/a.http', newPath: '/ws/requests/b.http' }])

    expect(store.getState().tabs.filter((t) => t.filePath === '/ws/requests/b.http')).toHaveLength(
      2
    )
    expect(store.getState().tabs.every((t) => t.filePath !== '/ws/requests/a.http')).toBe(true)
  })

  it('applies several mappings at once (folder children + instance)', () => {
    store.getState().openTab({ title: 'child', filePath: '/ws/requests/old/child.http' })
    store.getState().openTab({ title: 'inst', filePath: '/ws/requests/old/child.qa.instance.http' })

    store.getState().repointTabs([
      { oldPath: '/ws/requests/old/child.http', newPath: '/ws/requests/new/child.http' },
      {
        oldPath: '/ws/requests/old/child.qa.instance.http',
        newPath: '/ws/requests/new/child.qa.instance.http'
      }
    ])

    expect(store.getState().tabs.map((t) => t.filePath)).toEqual([
      '/ws/requests/new/child.http',
      '/ws/requests/new/child.qa.instance.http'
    ])
  })

  it('ignores mappings whose old path has no open tab', () => {
    store.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    const before = store.getState().tabs
    store
      .getState()
      .repointTabs([{ oldPath: '/ws/requests/nope.http', newPath: '/ws/requests/x.http' }])
    expect(store.getState().tabs).toBe(before)
  })
})

describe('restoreSession — preview marker', () => {
  it('restores a tab marked preview as a preview tab (CA-08)', () => {
    store
      .getState()
      .restoreSession([{ path: '/ws/a.http' }, { path: '/ws/b.http', mode: 'preview' }], 0)
    const s = store.getState()
    expect(s.tabs[0].mode).not.toBe('preview')
    expect(s.tabs[1].mode).toBe('preview')
  })

  it('a session without markers restores all tabs permanent (back-compat)', () => {
    store.getState().restoreSession([{ path: '/ws/a.http' }, { path: '/ws/b.http' }], 1)
    expect(store.getState().tabs.every((t) => t.mode !== 'preview')).toBe(true)
  })

  it('honours only the first preview marker (single-preview invariant)', () => {
    store.getState().restoreSession(
      [
        { path: '/ws/a.http', mode: 'preview' },
        { path: '/ws/b.http', mode: 'preview' }
      ],
      0
    )
    const s = store.getState()
    expect(s.tabs.filter((t) => t.mode === 'preview')).toHaveLength(1)
    expect(s.tabs[0].mode).toBe('preview')
    expect(s.tabs[1].mode).toBe('permanent')
  })
})

// ── Tab pinning + MRU + close-to-side (REQ keyboard tree/tab management) ──────

describe('pinTab / unpinTab', () => {
  it('pins a tab to the front group and promotes it out of preview (CA-11, CA-12)', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openPreviewTab({ title: 'B', filePath: '/ws/b.http' })
    const previewId = store.getState().tabs.find((t) => t.mode === 'preview')!.id
    store.getState().pinTab(previewId)
    const s = store.getState()
    expect(s.tabs[0].id).toBe(previewId) // moved to the front
    // The enum captures both facts at once: pinned (and therefore not preview).
    expect(s.tabs[0].mode).toBe('pinned')
  })

  it('unpins to the front of the unpinned group', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openTab({ title: 'B', filePath: '/ws/b.http' })
    const [a, b] = store.getState().tabs.map((t) => t.id)
    store.getState().pinTab(a)
    store.getState().pinTab(b) // order: [a, b] both pinned
    store.getState().unpinTab(a) // a back to front of unpinned
    expect(store.getState().tabs.map((t) => t.id)).toEqual([b, a])
    expect(store.getState().tabs.find((t) => t.id === a)?.mode).toBe('permanent')
  })

  it('reorderTabs clamps a cross-boundary drag (pinned ↔ unpinned)', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openTab({ title: 'B', filePath: '/ws/b.http' })
    const [a, b] = store.getState().tabs.map((t) => t.id)
    store.getState().pinTab(a) // [a*, b]
    const before = store.getState().tabs
    store.getState().reorderTabs(b, a) // b (unpinned) onto a (pinned) → clamped
    expect(store.getState().tabs).toBe(before)
  })
})

describe('bulk closes spare pinned tabs', () => {
  function seedPinnedFirst(): { pinnedId: string; ids: string[] } {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openTab({ title: 'B', filePath: '/ws/b.http' })
    store.getState().openTab({ title: 'C', filePath: '/ws/c.http' })
    store.getState().openTab({ title: 'D', filePath: '/ws/d.http' })
    const tabs = store.getState().tabs
    const pinnedId = tabs[0].id
    store.getState().pinTab(pinnedId) // already front; now pinned
    return { pinnedId, ids: store.getState().tabs.map((t) => t.id) }
  }

  it('closeOtherTabs keeps the target and every pinned tab (CA-11)', () => {
    const { pinnedId } = seedPinnedFirst()
    const target = store.getState().tabs.find((t) => t.id !== pinnedId)!.id
    store.getState().closeOtherTabs(target)
    const kept = store.getState().tabs.map((t) => t.id)
    expect(kept).toContain(pinnedId)
    expect(kept).toContain(target)
    expect(kept).toHaveLength(2)
  })

  it('closeAllTabs leaves the pinned tabs open and active (CA-10)', () => {
    const { pinnedId } = seedPinnedFirst()
    store.getState().closeAllTabs()
    const s = store.getState()
    expect(s.tabs.map((t) => t.id)).toEqual([pinnedId])
    expect(s.activeTabId).toBe(pinnedId)
  })

  it('closeTabsToRight closes the tabs after the target, sparing pinned (CA-09)', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openTab({ title: 'B', filePath: '/ws/b.http' })
    store.getState().openTab({ title: 'C', filePath: '/ws/c.http' })
    const [a, b] = store.getState().tabs.map((t) => t.id)
    store.getState().closeTabsToRight(b)
    expect(store.getState().tabs.map((t) => t.id)).toEqual([a, b])
  })

  it('closeTabsToLeft closes every tab before the target', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openTab({ title: 'B', filePath: '/ws/b.http' })
    store.getState().openTab({ title: 'C', filePath: '/ws/c.http' })
    const [, , c] = store.getState().tabs.map((t) => t.id)
    store.getState().closeTabsToLeft(c)
    expect(store.getState().tabs.map((t) => t.id)).toEqual([c])
  })
})

describe('MRU order', () => {
  it('setActiveTab moves the tab to the front of the MRU (CA-07)', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openTab({ title: 'B', filePath: '/ws/b.http' })
    store.getState().openTab({ title: 'C', filePath: '/ws/c.http' })
    const [a, b, c] = store.getState().tabs.map((t) => t.id)
    // After opening A, B, C the MRU is [C, B, A]; the previously-used tab is B.
    expect(store.getState().mruIds).toEqual([c, b, a])
    store.getState().setActiveTab(a)
    expect(store.getState().mruIds[0]).toBe(a)
  })

  it('closing a tab prunes it from the MRU', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openTab({ title: 'B', filePath: '/ws/b.http' })
    const [a, b] = store.getState().tabs.map((t) => t.id)
    store.getState().closeTab(b)
    expect(store.getState().mruIds).not.toContain(b)
    expect(store.getState().mruIds).toContain(a)
  })

  it('cycleActiveTab activates without reordering the MRU', () => {
    store.getState().openTab({ title: 'A', filePath: '/ws/a.http' })
    store.getState().openTab({ title: 'B', filePath: '/ws/b.http' })
    const mruBefore = store.getState().mruIds
    const [a] = store.getState().tabs.map((t) => t.id)
    store.getState().cycleActiveTab(a)
    expect(store.getState().activeTabId).toBe(a)
    expect(store.getState().mruIds).toEqual(mruBefore) // unchanged during a cycle
  })
})

describe('restoreSession — pinned marker (CA-13)', () => {
  it('restores a pinned tab grouped at the front', () => {
    store
      .getState()
      .restoreSession(
        [{ path: '/ws/a.http' }, { path: '/ws/b.http', mode: 'pinned' }, { path: '/ws/c.http' }],
        0
      )
    const s = store.getState()
    expect(s.tabs[0].filePath).toBe('/ws/b.http')
    expect(s.tabs[0].mode).toBe('pinned')
    // activeIndex 0 referenced 'a' in the persisted order; it stays active after regroup.
    expect(s.tabs.find((t) => t.id === s.activeTabId)?.filePath).toBe('/ws/a.http')
  })

  it('a session without the marker restores all tabs permanent (back-compat)', () => {
    store.getState().restoreSession([{ path: '/ws/a.http' }, { path: '/ws/b.http' }], 0)
    expect(store.getState().tabs.every((t) => t.mode === 'permanent')).toBe(true)
  })
})
