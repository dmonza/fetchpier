// REQ-0069 — acceptance criteria CA-01..CA-08 expressed as component tests.
//
// All `window.api` is mocked; we assert on the exact number of `history.get`
// calls to prove lazy fetch + cache (CA-03) and on the inline error state
// (CA-08). The descriptor + RunDetail orchestration is covered separately in
// `run-detail/RunDetail.test.tsx`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HistoryEntryListItem } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key, opts) => (opts && 'ms' in opts ? `${(opts as { ms: number }).ms} ms` : key)
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
  }
  filesystem: {
    fileExists: ReturnType<typeof vi.fn>
  }
}

function installApi(
  items: HistoryEntryListItem[],
  getImpl: (id: string) => Promise<string>
): ApiMock {
  const api: ApiMock = {
    history: {
      list: vi.fn().mockResolvedValue(items),
      get: vi.fn((_ws: string, id: string) => getImpl(id)),
      clear: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    },
    filesystem: {
      fileExists: vi.fn().mockResolvedValue(true)
    }
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
