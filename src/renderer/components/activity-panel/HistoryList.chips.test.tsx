// ISS-0081 — History chips carry the real request id of every open tab.
//
// Unlike HistoryList.test.tsx, the request and chip stores are the real ones:
// a session is restored through `restoreSession`, the History list resolves the
// tabs' ids through the real resolver, and only `window.api` is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HistoryEntryListItem, HistoryListFilter, ParsedHttpFile } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key) => key })
}))
vi.mock('../../hooks/useCodeMirror', () => ({ useCodeMirror: () => {} }))

const workspaceState = { workspacePath: '/ws' as string | null }
vi.mock('../../stores/workspace', () => ({
  useWorkspaceStore: <T,>(selector: (s: typeof workspaceState) => T): T => selector(workspaceState)
}))

import { HistoryList } from './HistoryList'
import { useRequestStore } from '../../stores/request'
import { useHistoryChipsStore } from '../../stores/historyChips'
import { historyEntryMatcher } from '../../../shared/lib/history-filter'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

const parsed = (requestId?: string): ParsedHttpFile => ({
  requests: [{ method: 'GET', url: 'https://x/', headers: {} }],
  variablesUsed: [],
  ...(requestId ? { requestId } : {})
})

const runOf = (
  id: string,
  requestId: string | undefined,
  sourceFile: string
): HistoryEntryListItem => ({
  id,
  timestamp: '2026-11-16T10:00:00.000Z',
  requestId,
  sourceFile,
  request: { method: 'GET', url: `https://api.example.com/${id}` },
  response: { status: 200, statusText: 'OK' }
})

interface Api {
  list: ReturnType<typeof vi.fn>
  parseFile: ReturnType<typeof vi.fn>
}

/** A disk of runs that honours the filter with the shared rule, then the limit. */
function installApi(
  runs: HistoryEntryListItem[],
  parse: (path: string) => Promise<ParsedHttpFile>
): Api {
  const list = vi.fn(async (filter?: HistoryListFilter) =>
    runs.filter(historyEntryMatcher(filter ?? {})).slice(0, filter?.limit ?? Infinity)
  )
  const parseFile = vi.fn(parse)
  ;(window as unknown as { api: unknown }).api = {
    history: {
      list,
      get: vi.fn(),
      clear: vi.fn(),
      delete: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    filesystem: { fileExists: vi.fn() },
    request: { parseFile }
  }
  return { list, parseFile }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<HistoryList variant="panel" />)
  })
  await flush()
  return { container, root }
}

const rowCount = (c: HTMLElement): number => c.querySelectorAll('.cursor-pointer').length
const chipLabels = (c: HTMLElement): string[] =>
  Array.from(c.querySelectorAll('button[aria-pressed]')).map((b) => b.textContent?.trim() ?? '')

describe('HistoryList — chips of restored tabs (ISS-0081)', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null

  beforeEach(() => {
    document.body.replaceChildren()
    useRequestStore.getState().restoreSession([], -1)
    useHistoryChipsStore.getState().reset()
  })
  afterEach(() => {
    if (mounted) act(() => mounted!.root.unmount())
    mounted = null
  })

  it("lists every restored tab's runs, not only the active one's, once the panel opens", async () => {
    const api = installApi(
      [
        runOf('r-a', ID_A, 'requests/a.http'),
        runOf('r-b', ID_B, 'requests/b.http'),
        runOf('r-c', ID_C, 'requests/c.http'),
        runOf('r-x', 'req-other', 'requests/x.http')
      ],
      async (p) => parsed(p.endsWith('a.http') ? ID_A : p.endsWith('b.http') ? ID_B : ID_C)
    )
    useRequestStore
      .getState()
      .restoreSession(
        [
          { path: '/ws/requests/a.http' },
          { path: '/ws/requests/b.http' },
          { path: '/ws/requests/c.http' }
        ],
        0
      )
    // Restoring alone reads no file: the ids are read when the History list opens.
    expect(api.parseFile).not.toHaveBeenCalled()

    mounted = await mount()

    expect(api.parseFile).toHaveBeenCalledTimes(3)
    // The first listing already carries the files' ids — no listing with random ids.
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.list.mock.calls[0]![0]).toEqual({ requestIds: [ID_A, ID_B, ID_C], limit: 50 })
    expect(chipLabels(mounted.container)).toEqual(['a', 'b', 'c'])
    expect(rowCount(mounted.container)).toBe(3)
  })

  it("lists the runs of a file with no # @id by its path, recorded under earlier sessions' ids", async () => {
    const api = installApi(
      [
        runOf('r-old-1', 'random-session-1', 'requests/col/noid.http'),
        runOf('r-old-2', 'random-session-2', 'requests/col/noid.http'),
        // A CLI run records no request id and may be another request of the file.
        runOf('r-cli', undefined, 'requests/col/noid.http'),
        runOf('r-x', 'req-other', 'requests/x.http')
      ],
      async () => parsed()
    )
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/col/noid.http' }], 0)

    mounted = await mount()

    const ownId = useRequestStore.getState().tabs[0]!.requestId
    expect(api.list.mock.calls.at(-1)![0]).toEqual({
      requestIds: [ownId],
      sourceFiles: ['requests/col/noid.http'],
      limit: 50
    })
    expect(rowCount(mounted.container)).toBe(2)
    expect(mounted.container.textContent).not.toContain('r-cli')
  })

  it('a tab opened while the panel is shown gets its chip with the file id', async () => {
    const api = installApi([runOf('r-a', ID_A, 'requests/a.http')], async () => parsed(ID_A))
    mounted = await mount()
    expect(chipLabels(mounted.container)).toEqual([])

    await act(async () => {
      useRequestStore.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    })
    await flush()

    expect(useHistoryChipsStore.getState().chips.map((c) => c.requestId)).toEqual([ID_A])
    expect(api.list.mock.calls.at(-1)![0]).toEqual({ requestIds: [ID_A], limit: 50 })
    expect(rowCount(mounted.container)).toBe(1)
  })
})
