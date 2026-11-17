// ISS-0073 — while the Activity panel is detached, the main window keeps its
// request chips in step with its tabs and publishes them to the popout; a chip
// toggled in the popout comes back here. Real request and chip stores; only
// `window.api` and the workspace store are mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ParsedHttpFile } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key) => key })
}))
vi.mock('./ActivityPanel', () => ({ ActivityPanel: (): null => null }))

const workspaceState = { workspacePath: '/ws' as string | null }
vi.mock('../../stores/workspace', () => ({
  useWorkspaceStore: <T,>(selector: (s: typeof workspaceState) => T): T => selector(workspaceState)
}))

import { PopoutChipsPublisher } from './PopoutChipsPublisher'
import { ActivityPanelHost } from './ActivityPanelHost'
import { useRequestStore } from '../../stores/request'
import { useHistoryChipsStore } from '../../stores/historyChips'
import { useActivityPanelStore } from '../../stores/activityPanel'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

const parsed = (requestId?: string): ParsedHttpFile => ({
  requests: [{ method: 'GET', url: 'https://x/', headers: {} }],
  variablesUsed: [],
  ...(requestId ? { requestId } : {})
})

interface Api {
  publishChips: ReturnType<typeof vi.fn>
  onChipToggle: ReturnType<typeof vi.fn>
  unsubscribeToggle: ReturnType<typeof vi.fn>
  parseFile: ReturnType<typeof vi.fn>
  emitToggle: (requestId: string) => void
}

function installApi(parse: (path: string) => Promise<ParsedHttpFile>): Api {
  let toggleCallback: ((id: string) => void) | null = null
  const unsubscribeToggle = vi.fn()
  const api: Api = {
    publishChips: vi.fn().mockResolvedValue(true),
    onChipToggle: vi.fn((cb: (id: string) => void) => {
      toggleCallback = cb
      return unsubscribeToggle
    }),
    unsubscribeToggle,
    parseFile: vi.fn(parse),
    emitToggle: (id) => toggleCallback?.(id)
  }
  ;(window as unknown as { api: unknown }).api = {
    activityPanel: { publishChips: api.publishChips, onChipToggle: api.onChipToggle },
    request: { parseFile: api.parseFile }
  }
  return api
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function mount(node: React.ReactNode): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
  await flush()
  return { container, root }
}

const lastPublished = (api: Api): unknown => api.publishChips.mock.calls.at(-1)?.[0]

describe('PopoutChipsPublisher — the main window publishes its chips while detached', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null

  beforeEach(() => {
    document.body.replaceChildren()
    useRequestStore.getState().restoreSession([], -1)
    useHistoryChipsStore.getState().reset()
  })
  afterEach(() => {
    if (mounted) act(() => mounted!.root.unmount())
    mounted = null
    useActivityPanelStore.setState({ isOpen: false, isDetached: false })
  })

  it("publishes the tabs' chips once their ids are read, not before", async () => {
    let answer: (p: ParsedHttpFile) => void = () => {}
    const api = installApi(
      (p) =>
        new Promise((resolve) => {
          if (p.endsWith('a.http')) answer = resolve
          else resolve(parsed(ID_B))
        })
    )
    useRequestStore
      .getState()
      .restoreSession([{ path: '/ws/requests/auth/a.http' }, { path: '/ws/requests/b.http' }], 0)
    mounted = await mount(<PopoutChipsPublisher />)
    expect(api.publishChips).not.toHaveBeenCalled()

    await act(async () => {
      answer(parsed(ID_A))
    })
    await flush()
    expect(api.publishChips).toHaveBeenCalledTimes(1)
    expect(lastPublished(api)).toEqual([
      { requestId: ID_A, label: 'auth/a', checked: true },
      { requestId: ID_B, label: 'b', checked: true }
    ])
  })

  it('keeps the checked state the chips had before the panel was detached', async () => {
    const api = installApi(async () => parsed(ID_A))
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/a.http' }], 0)
    // The docked list had already read the tab's id and the user unchecked it.
    const tab = useRequestStore.getState().tabs[0]!
    useRequestStore.getState().updateTab(tab.id, { requestId: ID_A, requestIdSource: 'file' })
    useHistoryChipsStore.setState({
      chips: [{ requestId: ID_A, label: 'a', checked: false }]
    })
    mounted = await mount(<PopoutChipsPublisher />)
    expect(lastPublished(api)).toEqual([{ requestId: ID_A, label: 'a', checked: false }])
  })

  it('publishes an empty set when no saved request is open', async () => {
    const api = installApi(async () => parsed())
    mounted = await mount(<PopoutChipsPublisher />)
    expect(lastPublished(api)).toEqual([])
  })

  it('toggles a chip the popout sends back and publishes the result', async () => {
    const api = installApi(async () => parsed(ID_A))
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/a.http' }], 0)
    mounted = await mount(<PopoutChipsPublisher />)
    await act(async () => {
      api.emitToggle(ID_A)
    })
    await flush()
    expect(useHistoryChipsStore.getState().chips[0]!.checked).toBe(false)
    expect(lastPublished(api)).toEqual([{ requestId: ID_A, label: 'a', checked: false }])
  })

  it('publishes a tab opened while detached, and stops listening once unmounted', async () => {
    const api = installApi(async (p) => parsed(p.endsWith('a.http') ? ID_A : ID_B))
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/a.http' }], 0)
    mounted = await mount(<PopoutChipsPublisher />)
    await act(async () => {
      useRequestStore
        .getState()
        .restoreSession([{ path: '/ws/requests/a.http' }, { path: '/ws/requests/b.http' }], 0)
    })
    await flush()
    expect(lastPublished(api)).toEqual([
      { requestId: ID_A, label: 'a', checked: true },
      { requestId: ID_B, label: 'b', checked: true }
    ])
    act(() => mounted!.root.unmount())
    mounted = null
    expect(api.unsubscribeToggle).toHaveBeenCalledTimes(1)
  })

  it('the docked host runs it only while the panel is detached', async () => {
    const api = installApi(async () => parsed())
    useActivityPanelStore.setState({ isOpen: true, isDetached: false })
    mounted = await mount(<ActivityPanelHost />)
    expect(api.publishChips).not.toHaveBeenCalled()
    await act(async () => {
      useActivityPanelStore.setState({ isOpen: false, isDetached: true })
    })
    await flush()
    expect(api.publishChips).toHaveBeenCalledTimes(1)
    await act(async () => {
      useActivityPanelStore.setState({ isOpen: true, isDetached: false })
    })
    await flush()
    expect(api.unsubscribeToggle).toHaveBeenCalledTimes(1)
  })
})
