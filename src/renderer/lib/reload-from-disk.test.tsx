import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_REQUEST_STATE, type ParsedHttpFile, type Tab } from '../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key) => key })
}))

// The modal asks for a workspace only for an untitled tab with none open.
vi.mock('../stores/workspaceRequired', () => ({
  withWorkspace: (fn: () => Promise<void>): Promise<void> => fn()
}))

import { useRequestStore } from '../stores/request'
import { guardDiscard, useUnsavedGuardStore } from '../stores/unsavedGuard'
import { UnsavedChangesModal } from '../components/layout/UnsavedChangesModal'
import { applyReloadFromDisk } from './reload-from-disk'
import { cleanHashOf } from './tab-dirty'

const writeFile = vi.fn().mockResolvedValue(undefined)
let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  writeFile.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    filesystem: { writeFile, findAvailableUntitledPath: vi.fn() },
    window: { closeConfirmed: vi.fn().mockResolvedValue(undefined) }
  }
  useUnsavedGuardStore.getState().clear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
  useRequestStore.setState({ tabs: [], activeTabId: null, mruIds: [] })
})

/** A loaded tab, edited since, whose file changed on disk (the conflict banner shows). */
function conflictedTab(): Tab {
  const loaded = {
    request: { ...DEFAULT_REQUEST_STATE, url: 'https://api.example.com/users' },
    requestId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    tail: undefined
  }
  return {
    id: 't1',
    title: 'users',
    filePath: '/ws/requests/users.http',
    isDirty: true,
    response: null,
    isLoading: false,
    error: null,
    mode: 'permanent',
    ...loaded,
    request: { ...loaded.request, url: 'https://api.example.com/users/edited' },
    cleanHash: cleanHashOf(loaded),
    conflict: true
  }
}

/** The on-disk version holds content but no request the editor can read. */
const unreadable: ParsedHttpFile = { requests: [], variablesUsed: [] }

describe('Reload of an unreadable file, then the unsaved-edit guard (ISS-0053)', () => {
  it('never writes the file: Reload drops the edits, so neither the guard nor the modal saves it', async () => {
    useRequestStore.setState({ tabs: [conflictedTab()], activeTabId: 't1', mruIds: ['t1'] })

    // Reload from the conflict banner.
    applyReloadFromDisk('t1', unreadable)

    // Then the window closes: the guard, and its modal's Save if it prompts.
    const proceed = vi.fn().mockResolvedValue(undefined)
    await guardDiscard(useRequestStore.getState().tabs, proceed)
    const pending = useUnsavedGuardStore.getState().pending
    if (pending) {
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      act(() =>
        root!.render(
          <UnsavedChangesModal
            tabs={pending.tabs}
            workspacePath="/ws"
            onProceed={pending.onProceed}
            onClose={() => useUnsavedGuardStore.getState().clear()}
          />
        )
      )
      const save = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === 'closeGuard.saveAndClose'
      )!
      await act(async () => save.click())
    }

    expect(writeFile).not.toHaveBeenCalled()
    expect(proceed).toHaveBeenCalledTimes(1)

    // The tab is left as a first open of that file leaves it: flagged, holding
    // none of the discarded edits, with no baseline.
    const tab = useRequestStore.getState().tabs[0]
    expect(tab.unreadableOnLoad).toBe(true)
    expect(tab.conflict).toBe(false)
    expect(tab.cleanHash).toBeUndefined()
    expect(tab.isDirty).toBe(false)
    expect(tab.request.url).toBe('')
  })
})
