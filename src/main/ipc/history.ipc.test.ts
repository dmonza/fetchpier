/**
 * The history channels: `history:list` validates its filter before it reaches
 * the workspace, and every handler that changes the runs on disk tells every
 * window (`history:changed`) so a popped-out Activity panel converges.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, Handler>()

interface FakeWindow {
  destroyed: boolean
  sent: string[]
  isDestroyed: () => boolean
  webContents: { send: (channel: string) => void }
}

function fakeWindow(destroyed = false): FakeWindow {
  const w: FakeWindow = {
    destroyed,
    sent: [],
    isDestroyed: () => w.destroyed,
    webContents: { send: (channel) => w.sent.push(channel) }
  }
  return w
}

let windows: FakeWindow[] = []

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => windows }
}))

const historyOps = {
  save: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  updateSourceFile: vi.fn(),
  countForPath: vi.fn(),
  deleteForPath: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn()
}
vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: () => ({ history: historyOps })
}))

const { registerHistoryHandlers } = await import('./history.ipc')
registerHistoryHandlers()

const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
  handlers.get(channel)!(null, ...args)

beforeEach(() => {
  windows = [fakeWindow(), fakeWindow(), fakeWindow(true)]
  for (const fn of Object.values(historyOps)) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  historyOps.list.mockResolvedValue([])
})

describe('history:list — filter', () => {
  it('passes the request ids and the limit through', async () => {
    await call('history:list', { requestIds: ['req-a', 'req-b'], limit: 50 })
    expect(historyOps.list).toHaveBeenCalledWith({ requestIds: ['req-a', 'req-b'], limit: 50 })
  })

  it('accepts no filter', async () => {
    await call('history:list')
    expect(historyOps.list).toHaveBeenCalledWith(undefined)
  })

  it.each([
    ['a non-object filter', 'req-a'],
    ['requestIds that is not an array', { requestIds: 'req-a' }],
    ['a requestIds entry that is not a string', { requestIds: ['req-a', 7] }],
    ['a requestId that is not a string', { requestId: 7 }],
    ['a negative limit', { limit: -1 }],
    ['a limit that is not a number', { limit: '50' }]
  ])('rejects %s without listing', async (_label, filter) => {
    await expect(call('history:list', filter)).rejects.toThrow(/invalid history filter/i)
    expect(historyOps.list).not.toHaveBeenCalled()
  })
})

describe('history:changed broadcast', () => {
  it.each([
    ['history:save', [{ id: 'run-1' }]],
    ['history:delete', ['run-1']],
    ['history:clear', []],
    ['history:deleteForPath', ['requests/a.http', false]],
    ['history:updateSourceFile', ['requests/a.http', 'requests/b.http', false]]
  ])('%s tells every live window once it succeeds', async (channel, args) => {
    await call(channel, ...args)
    expect(windows.map((w) => w.sent)).toEqual([['history:changed'], ['history:changed'], []])
  })

  it('a failed change tells no window', async () => {
    historyOps.clear.mockRejectedValue(new Error('EACCES'))
    await expect(call('history:clear')).rejects.toThrow('EACCES')
    expect(windows.every((w) => w.sent.length === 0)).toBe(true)
  })

  it.each([
    ['history:list', []],
    ['history:get', ['run-1']],
    ['history:countForPath', ['requests/a.http', false]]
  ])('%s (a read) tells no window', async (channel, args) => {
    await call(channel, ...args)
    expect(windows.every((w) => w.sent.length === 0)).toBe(true)
  })
})
