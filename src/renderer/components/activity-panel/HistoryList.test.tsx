// REQ-0069 — acceptance criteria CA-01..CA-08 expressed as component tests.
//
// All `window.api` is mocked; we assert on the exact number of `history.get`
// calls to prove lazy fetch + cache (CA-03) and on the inline error state
// (CA-08). The descriptor + RunDetail orchestration is covered separately in
// `run-detail/RunDetail.test.tsx`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HistoryEntryListItem } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key, opts) => {
      if (opts && 'ms' in opts) return `${(opts as { ms: number }).ms} ms`
      // Makes the interpolated tab-title parts visible to the assertions.
      if (opts && 'url' in opts) {
        const o = opts as { method: string; url: string }
        return `${key}|${o.method}|${o.url}`
      }
      return key
    }
  })
}))

// CodeMirror is heavy and DOM-fussy in jsdom — stub the hook to a no-op.
vi.mock('../../hooks/useCodeMirror', () => ({ useCodeMirror: () => {} }))

// The HistoryList reads workspacePath/activeTab through hook selectors. We
// stub the stores with selector-aware shims so the production selectors keep
// working unchanged.
const workspaceState = { workspacePath: '/ws' as string | null }
vi.mock('../../stores/workspace', () => ({
  useWorkspaceStore: <T,>(selector: (s: typeof workspaceState) => T): T => selector(workspaceState)
}))

const TAB = {
  id: 'tab-1',
  requestId: 'req-1',
  isReadOnly: false,
  rawContent: undefined as string | undefined,
  filePath: null as string | null
}
const requestStoreState = {
  tabs: [TAB] as Array<typeof TAB>,
  activeTabId: TAB.id,
  openTab: vi.fn()
}
vi.mock('../../stores/request', () => {
  const useRequestStore = <T,>(selector: (s: typeof requestStoreState) => T): T =>
    selector(requestStoreState)
  ;(useRequestStore as unknown as { getState: () => typeof requestStoreState }).getState = () =>
    requestStoreState
  return { useRequestStore }
})

import { HistoryList } from './HistoryList'
import { useHistoryExpansionStore } from '../../stores/historyExpansion'
import { useHistoryChipsStore } from '../../stores/historyChips'

const RAW =
  '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
  '# @run-id: run-1\n' +
  '# @request-id: req-1\n' +
  '# @source-file: requests/foo.http\n' +
  '# @duration-ms: 184\n' +
  '# @path-raw: https://api.example.com/foo\n' +
  '# @remote-ip: 203.0.113.42\n' +
  '\n' +
  'GET https://api.example.com/foo HTTP/1.1\n' +
  'Accept: application/json\n' +
  '\n' +
  '### Response\n' +
  '\n' +
  'HTTP/1.1 200 OK\n' +
  'Content-Type: application/json\n' +
  '\n' +
  '{"ok":true}\n'

const ITEM_A: HistoryEntryListItem = {
  id: 'run-1',
  timestamp: '2026-05-15T14:23:04.123Z',
  requestId: 'req-1',
  sourceFile: 'requests/foo.http',
  durationMs: 184,
  request: { method: 'GET', url: 'https://api.example.com/foo' },
  response: { status: 200, statusText: 'OK' }
}
const ITEM_B: HistoryEntryListItem = {
  ...ITEM_A,
  id: 'run-2',
  request: { method: 'POST', url: 'https://api.example.com/bar' }
}

interface ApiMock {
  history: {
    list: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    onChanged: ReturnType<typeof vi.fn>
  }
  filesystem: {
    fileExists: ReturnType<typeof vi.fn>
  }
  /** The callback HistoryList handed to `history.onChanged`, if any. */
  emitChanged: () => void
  unsubscribeChanged: ReturnType<typeof vi.fn>
}

function installApi(
  items: HistoryEntryListItem[],
  getImpl: (id: string) => Promise<string>
): ApiMock {
  let changedCallback: (() => void) | null = null
  const unsubscribeChanged = vi.fn()
  const api: ApiMock = {
    history: {
      list: vi.fn().mockResolvedValue(items),
      get: vi.fn((_ws: string, id: string) => getImpl(id)),
      clear: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn((cb: () => void) => {
        changedCallback = cb
        return unsubscribeChanged
      })
    },
    filesystem: {
      fileExists: vi.fn().mockResolvedValue(true)
    },
    emitChanged: () => changedCallback?.(),
    unsubscribeChanged
  }
  ;(window as unknown as { api: ApiMock }).api = api
  return api
}

async function mountList(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<HistoryList variant="panel" />)
  })
  // Flush pending microtasks (history:list resolution + re-render)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return { container, root }
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => root.unmount())
  container.remove()
}

function findRowByText(container: HTMLElement, text: string): HTMLElement {
  const rows = Array.from(container.querySelectorAll('div')) as HTMLElement[]
  const row = rows.find(
    (d) => d.textContent?.includes(text) && d.classList.contains('cursor-pointer')
  )
  if (!row) throw new Error(`row not found: ${text}`)
  return row
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function clickRow(container: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    findRowByText(container, text).click()
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('HistoryList expansion (REQ-0069 CA-01..CA-08)', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    useHistoryExpansionStore.getState().reset()
  })

  it('CA-01: clicking a collapsed row expands it in place', async () => {
    installApi([ITEM_A], async () => RAW)
    const { container, root } = await mountList()
    expect(container.querySelectorAll('section').length).toBe(0)
    await clickRow(container, 'https://api.example.com/foo')
    // 3 sections (no scripts in fixture): Metadata, Request, Response
    expect(container.querySelectorAll('section').length).toBe(3)
    unmount(root, container)
  })

  it('CA-02: multiple rows can be expanded simultaneously', async () => {
    installApi([ITEM_A, ITEM_B], async () => RAW)
    const { container, root } = await mountList()
    await clickRow(container, 'https://api.example.com/foo')
    await clickRow(container, 'https://api.example.com/bar')
    // 3 sections per row × 2 rows = 6
    expect(container.querySelectorAll('section').length).toBe(6)
    unmount(root, container)
  })

  it('CA-03: content is cached while expanded, re-fetched after a collapse (REQ-0104 supersedes the prior cache-forever behavior)', async () => {
    const api = installApi([ITEM_A], async () => RAW)
    const { container, root } = await mountList()
    await clickRow(container, 'https://api.example.com/foo') // expand → fetch
    expect(api.history.get).toHaveBeenCalledTimes(1)
    await clickRow(container, 'https://api.example.com/foo') // collapse → evicts (REQ-0104)
    await clickRow(container, 'https://api.example.com/foo') // re-expand → cache miss, re-fetches
    expect(api.history.get).toHaveBeenCalledTimes(2)
    unmount(root, container)
  })

  it('CA-08: fetch failure shows inline error and the row stays expandable', async () => {
    const api = installApi([ITEM_A], async () => {
      throw new Error('ENOENT')
    })
    const { container, root } = await mountList()
    await clickRow(container, 'https://api.example.com/foo')
    expect(container.textContent).toContain('history.expansion.errors.fetchFailed')
    // Retry button is present
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const retry = buttons.find((b) => b.textContent === 'history.expansion.errors.retry')
    expect(retry).toBeDefined()
    expect(api.history.get).toHaveBeenCalledTimes(1)
    unmount(root, container)
  })
})

describe('HistoryList — Repeat keeps the recorded query', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    useHistoryExpansionStore.getState().reset()
    requestStoreState.openTab.mockClear()
  })

  it('opens a tab whose parameters come from # @path-raw', async () => {
    installApi([ITEM_A], async () =>
      RAW.replace(
        '# @path-raw: https://api.example.com/foo\n',
        '# @path-raw: {{baseUrl}}/foo?page=2&token={{token}}\n'
      )
    )
    const { container, root } = await mountList()
    const repeat = container.querySelector('button[title="history.repeat"]') as HTMLButtonElement
    await act(async () => {
      repeat.click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(requestStoreState.openTab).toHaveBeenCalledTimes(1)
    const opened = requestStoreState.openTab.mock.calls[0][0] as {
      request: { url: string; params: { key: string; value: string }[] }
    }
    expect(opened.request.url).toBe('{{baseUrl}}/foo')
    expect(opened.request.params.map((p) => [p.key, p.value])).toEqual([
      ['page', '2'],
      ['token', '{{token}}']
    ])
    unmount(root, container)
  })
})

describe('HistoryList — Raw .http tab title (HIS-22)', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    useHistoryExpansionStore.getState().reset()
    requestStoreState.openTab.mockClear()
  })

  async function openRaw(container: HTMLElement, rowText: string): Promise<void> {
    act(() => {
      findRowByText(container, rowText).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, button: 2 })
      )
    })
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === 'history.contextMenu.raw'
    ) as HTMLElement | undefined
    expect(item).toBeDefined()
    await act(async () => {
      item!.click()
    })
    await flush()
  }

  it('builds the title through t() with the method and the URL', async () => {
    installApi([ITEM_A], async () => RAW)
    const { container, root } = await mountList()
    await openRaw(container, 'https://api.example.com/foo')
    expect(requestStoreState.openTab).toHaveBeenCalledTimes(1)
    const opened = requestStoreState.openTab.mock.calls[0][0] as { title: string }
    expect(opened.title).toBe('history.rawTabTitle|GET|https://api.example.com/foo')
    unmount(root, container)
  })

  it('passes a URL longer than 30 characters truncated with an ellipsis', async () => {
    const long = {
      ...ITEM_A,
      request: { method: 'POST', url: 'https://api.example.com/a/b/c/d/e' }
    }
    installApi([long], async () => RAW)
    const { container, root } = await mountList()
    await openRaw(container, 'https://api.example.com/a/b/c/d/e')
    const opened = requestStoreState.openTab.mock.calls[0][0] as { title: string }
    expect(opened.title).toBe('history.rawTabTitle|POST|https://api.example.com/a/b/c/…')
    unmount(root, container)
  })
})

describe('HistoryList — request chips filter on disk, before the page limit', () => {
  const savedTabs = requestStoreState.tabs
  const TAB_A = { ...TAB, id: 'tab-a', requestId: 'req-1', filePath: '/ws/requests/a.http' }
  const TAB_B = { ...TAB, id: 'tab-b', requestId: 'req-2', filePath: '/ws/requests/b.http' }

  // A disk of `count` runs, newest first, that honours `requestIds` then `limit`.
  function diskList(count: number, requestId = 'req-1') {
    const all = Array.from({ length: count }, (_, i) => ({ ...ITEM_A, id: `run-${i}`, requestId }))
    return async (filter?: { requestIds?: string[]; limit?: number }) => {
      const ids = filter?.requestIds
      const kept = ids && ids.length > 0 ? all.filter((e) => ids.includes(e.requestId)) : all
      return kept.slice(0, filter?.limit ?? Infinity)
    }
  }

  const lastListArg = (api: ApiMock): unknown => api.history.list.mock.calls.at(-1)?.[0]

  async function clickChip(container: HTMLElement, label: string): Promise<void> {
    const chip = Array.from(container.querySelectorAll('button[aria-pressed]')).find(
      (b) => b.textContent?.trim() === label
    ) as HTMLButtonElement
    await act(async () => {
      chip.click()
    })
    await flush()
  }

  beforeEach(() => {
    document.body.replaceChildren()
    useHistoryExpansionStore.getState().reset()
    useHistoryChipsStore.getState().reset()
    requestStoreState.tabs = [TAB_A, TAB_B]
  })
  afterEach(() => {
    requestStoreState.tabs = savedTabs
    useHistoryChipsStore.getState().reset()
  })

  it("asks the disk for the checked chips' runs, so a request with old runs still shows them", async () => {
    // 60 newer runs of another request would fill a whole-workspace page on their own.
    const api = installApi([], async () => RAW)
    const other = diskList(60, 'req-other')
    const mine = diskList(5, 'req-1')
    api.history.list.mockImplementation(async (f?: { requestIds?: string[]; limit?: number }) =>
      [...(await other(f)), ...(await mine(f))].slice(0, f?.limit ?? Infinity)
    )
    const { container, root } = await mountList()
    expect(lastListArg(api)).toEqual({ requestIds: ['req-1', 'req-2'], limit: 50 })
    expect(container.textContent).not.toContain('history.emptyForFile')
    expect(container.querySelectorAll('.cursor-pointer').length).toBe(5)
    unmount(root, container)
  })

  it('with no chip checked, lists every run as before', async () => {
    const api = installApi([], async () => RAW)
    api.history.list.mockImplementation(diskList(3))
    const { container, root } = await mountList()
    await clickChip(container, 'a')
    await clickChip(container, 'b')
    expect(lastListArg(api)).toEqual({ limit: 50 })
    unmount(root, container)
  })

  it('changing the chip selection starts again from the first page', async () => {
    const api = installApi([], async () => RAW)
    api.history.list.mockImplementation(diskList(200))
    const { container, root } = await mountList()
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await flush()
    expect(lastListArg(api)).toEqual({ requestIds: ['req-1', 'req-2'], limit: 100 })
    await clickChip(container, 'b')
    expect(lastListArg(api)).toEqual({ requestIds: ['req-1'], limit: 50 })
    unmount(root, container)
  })
})

describe('HistoryList — reloads when any window changes the runs', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    useHistoryExpansionStore.getState().reset()
  })

  it('reloads on history:changed and stops listening once unmounted', async () => {
    const api = installApi([ITEM_A], async () => RAW)
    const { container, root } = await mountList()
    expect(api.history.list).toHaveBeenCalledTimes(1)
    api.history.list.mockResolvedValue([ITEM_A, ITEM_B])
    await act(async () => {
      api.emitChanged()
    })
    await flush()
    expect(api.history.list).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('https://api.example.com/bar')
    unmount(root, container)
    expect(api.unsubscribeChanged).toHaveBeenCalledTimes(1)
  })
})
