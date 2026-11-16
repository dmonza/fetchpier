// ISS-0164: the main window runs the row actions the Activity popout forwards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityPanelRowAction } from '../../../shared/types'

const h = vi.hoisted(() => ({ run: vi.fn(async (): Promise<void> => {}) }))
vi.mock('./history-row-actions', () => ({ runHistoryRowAction: h.run }))

import { subscribeToForwardedRowActions } from './forwarded-row-actions'

type Deliver = (action: ActivityPanelRowAction) => void

const off = vi.fn()
const onRowAction = vi.fn((_cb: Deliver) => off)
const ctx = { workspacePath: '/ws-a', t: (k: string): string => k, pushToast: vi.fn() }
const ACTION: ActivityPanelRowAction = { kind: 'view', entryId: 'run-1' }

beforeEach(() => {
  h.run.mockReset()
  h.run.mockResolvedValue(undefined)
  off.mockReset()
  onRowAction.mockClear()
  vi.stubGlobal('window', { api: { activityPanel: { onRowAction } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function deliverer(): Deliver {
  return onRowAction.mock.calls[0]![0]
}

describe('subscribeToForwardedRowActions', () => {
  it('runs each forwarded action with the context current when it runs', async () => {
    let workspacePath = '/ws-a'
    subscribeToForwardedRowActions(() => ({ ...ctx, workspacePath }))
    workspacePath = '/ws-b'
    deliverer()(ACTION)
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    expect(h.run).toHaveBeenCalledWith(ACTION, expect.objectContaining({ workspacePath: '/ws-b' }))
  })

  it('runs nothing until an action arrives', () => {
    subscribeToForwardedRowActions(() => ctx)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('logs a failed action instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.run.mockRejectedValue(new Error('boom'))
    subscribeToForwardedRowActions(() => ctx)
    deliverer()(ACTION)
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
  })

  it('the returned function stops listening', () => {
    const unsubscribe = subscribeToForwardedRowActions(() => ctx)
    unsubscribe()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
