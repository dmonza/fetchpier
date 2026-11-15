import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_REQUEST_STATE, type Tab } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key) => key })
}))

// Asks for a workspace only for an untitled tab with none open; not exercised here.
vi.mock('../../stores/workspaceRequired', () => ({
  withWorkspace: (fn: () => Promise<void>): Promise<void> => fn()
}))

import { UnsavedChangesModal } from './UnsavedChangesModal'

const writeFile = vi.fn().mockResolvedValue(undefined)
let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  writeFile.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    filesystem: { writeFile, findAvailableUntitledPath: vi.fn() },
    window: { closeConfirmed: vi.fn().mockResolvedValue(undefined) }
  }
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

const tab = (id: string, overrides: Partial<Tab> = {}): Tab => ({
  id,
  title: id,
  filePath: `/ws/requests/${id}.http`,
  isDirty: true,
  request: { ...DEFAULT_REQUEST_STATE, url: `https://api.example.com/${id}` },
  response: null,
  isLoading: false,
  error: null,
  requestId: `req-${id}`,
  mode: 'permanent',
  cleanHash: 'stale-baseline',
  ...overrides
})

describe('UnsavedChangesModal', () => {
  it('never writes a tab whose file has no readable request, and saves the others (ISS-0053)', async () => {
    const onProceed = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root!.render(
        <UnsavedChangesModal
          tabs={[tab('unreadable', { unreadableOnLoad: true }), tab('users')]}
          workspacePath="/ws"
          onProceed={onProceed}
          onClose={onClose}
        />
      )
    )
    const save = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'closeGuard.saveAndClose'
    )!
    await act(async () => save.click())

    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledWith('/ws/requests/users.http', expect.any(String))
    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
