// ISS-0164: the History row actions, shared by the docked list and by the main
// window running an action the Activity popout forwarded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityPanelRowAction } from '../../../shared/types'

const requestState = vi.hoisted(() => ({
  tabs: [] as Array<{ id: string; filePath: string | null }>,
  openTab: vi.fn()
}))
vi.mock('../../stores/request', () => ({
  useRequestStore: { getState: () => requestState }
}))

import { runHistoryRowAction } from './history-row-actions'

const RAW =
  '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
  '# @run-id: run-1\n' +
  '# @request-id: req-1\n' +
  '# @source-file: requests/foo.http\n' +
  '# @path-raw: https://api.example.com/foo?page=2\n' +
  '\n' +
  'GET https://api.example.com/foo?page=2 HTTP/1.1\n' +
  '\n' +
  '### Response\n' +
  '\n' +
  'HTTP/1.1 200 OK\n' +
  '\n' +
  'ok\n'

const t = (key: string, opts?: Record<string, unknown>): string =>
  opts ? `${key}|${JSON.stringify(opts)}` : key
const pushToast = vi.fn()
const ctx = { workspacePath: '/ws', t, pushToast }

const api = {
  history: { get: vi.fn(async (_id: string): Promise<string> => RAW) },
  filesystem: { fileExists: vi.fn(async (_p: string): Promise<boolean> => true) }
}

beforeEach(() => {
  requestState.tabs = []
  requestState.openTab.mockReset()
  pushToast.mockReset()
  api.history.get.mockReset()
  api.history.get.mockResolvedValue(RAW)
  api.filesystem.fileExists.mockReset()
  api.filesystem.fileExists.mockResolvedValue(true)
  vi.stubGlobal('window', { api })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function opened(): Record<string, unknown> {
  expect(requestState.openTab).toHaveBeenCalledTimes(1)
  return requestState.openTab.mock.calls[0]![0] as Record<string, unknown>
}

describe('runHistoryRowAction — view', () => {
  it('opens the run as a read-only history tab', async () => {
    await runHistoryRowAction({ kind: 'view', entryId: 'run-1' }, ctx)
    expect(api.history.get).toHaveBeenCalledWith('run-1')
    const tab = opened()
    expect(tab).toMatchObject({ isReadOnly: true, historyEntryId: 'run-1', filePath: null })
    expect(tab.title).toBe('GET https://api.example.com/foo?page=2')
  })

  it('opens nothing when the run cannot be read', async () => {
    api.history.get.mockRejectedValue(new Error('entry not found'))
    await runHistoryRowAction({ kind: 'view', entryId: 'run-1' }, ctx)
    expect(requestState.openTab).not.toHaveBeenCalled()
  })

  it('does nothing without a workspace', async () => {
    await runHistoryRowAction({ kind: 'view', entryId: 'run-1' }, { ...ctx, workspacePath: null })
    expect(api.history.get).not.toHaveBeenCalled()
  })
})

describe('runHistoryRowAction — raw', () => {
  it('opens the file verbatim, titled from the method and the URL it carries', async () => {
    await runHistoryRowAction(
      { kind: 'raw', entryId: 'run-1', method: 'POST', url: 'https://api.example.com/a/b/c/d/e' },
      ctx
    )
    const tab = opened()
    expect(tab).toMatchObject({ isReadOnly: true, historyEntryId: 'raw:run-1', rawContent: RAW })
    expect(tab.title).toBe(
      'history.rawTabTitle|{"method":"POST","url":"https://api.example.com/a/b/c/…"}'
    )
  })

  it('opens nothing when the file cannot be read', async () => {
    api.history.get.mockRejectedValue(new Error('gone'))
    await runHistoryRowAction({ kind: 'raw', entryId: 'run-1', method: 'GET', url: 'u' }, ctx)
    expect(requestState.openTab).not.toHaveBeenCalled()
  })
})

describe('runHistoryRowAction — repeat', () => {
  it('focuses the source request when its tab is already open', async () => {
    const abs = '/ws/requests/foo.http'
    requestState.tabs = [{ id: 't1', filePath: abs }]
    await runHistoryRowAction({ kind: 'repeat', entryId: 'run-1' }, ctx)
    expect(opened()).toEqual({ filePath: abs })
  })

  it('otherwise opens an untitled request rebuilt from the run', async () => {
    await runHistoryRowAction({ kind: 'repeat', entryId: 'run-1' }, ctx)
    const tab = opened() as { filePath: unknown; request: { method: string; url: string } }
    expect(tab.filePath).toBeNull()
    expect(tab.request.method).toBe('GET')
    expect(tab.request.url).toBe('https://api.example.com/foo')
  })
})

describe('runHistoryRowAction — open source file', () => {
  const action: ActivityPanelRowAction = {
    kind: 'open-source-file',
    sourceFile: 'requests/users/list.http'
  }

  it('opens the file when it still exists', async () => {
    await runHistoryRowAction(action, ctx)
    expect(api.filesystem.fileExists).toHaveBeenCalledWith('/ws/requests/users/list.http')
    expect(opened()).toEqual({ filePath: '/ws/requests/users/list.http' })
  })

  it('joins with the workspace separator on Windows paths', async () => {
    await runHistoryRowAction(action, { ...ctx, workspacePath: 'C:\\ws' })
    expect(opened()).toEqual({ filePath: 'C:\\ws\\requests\\users\\list.http' })
  })

  it.each([
    ['is gone', async (): Promise<boolean> => false],
    [
      'cannot be checked',
      async (): Promise<boolean> => {
        throw new Error('io')
      }
    ]
  ])('toasts an error and opens nothing when the file %s', async (_label, impl) => {
    api.filesystem.fileExists.mockImplementation(impl)
    await runHistoryRowAction(action, ctx)
    expect(requestState.openTab).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(
      'history.expansion.errors.sourceFileMissing|{"path":"requests/users/list.http"}',
      { type: 'error' }
    )
  })
})
