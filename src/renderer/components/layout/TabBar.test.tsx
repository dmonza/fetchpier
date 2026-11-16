import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../i18n', () => ({ default: {} }))
vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

vi.mock('../LanguageSelector', () => ({ LanguageSelector: () => null }))
vi.mock('../ThemeToggle', () => ({ ThemeToggle: () => null }))
vi.mock('../environment/EnvironmentManager', () => ({ EnvironmentManager: () => null }))
vi.mock('./SettingsPanel', () => ({ SettingsPanel: () => null }))

import { TabBar } from './TabBar'
import { useRequestStore } from '../../stores/request'
import { useWorkspaceStore } from '../../stores/workspace'

let container: HTMLDivElement
let root: Root

function renderTabBar(): void {
  act(() => {
    root.render(<TabBar />)
  })
}

function tabElement(title: string): HTMLElement {
  const found = [...container.querySelectorAll('[role="tab"]')].find((el) =>
    el.textContent?.includes(title)
  )
  if (!found) throw new Error(`tab not found: ${title}`)
  return found as HTMLElement
}

describe('TabBar — middle-click close', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useWorkspaceStore.setState({ workspacePath: null, requestsRoot: null })
    useRequestStore.setState({ tabs: [], activeTabId: null, mruIds: [] })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('prevents default on middle mousedown so Chromium does not start autoscroll', () => {
    useRequestStore.getState().openTab({ title: 'Users', filePath: '/ws/requests/users.http' })
    renderTabBar()

    const tab = tabElement('Users')
    const downEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
    act(() => {
      tab.dispatchEvent(downEvent)
    })

    expect(downEvent.defaultPrevented).toBe(true)
    expect(useRequestStore.getState().tabs).toHaveLength(1)
  })

  it('closes a clean tab on middle-click (auxclick button === 1)', () => {
    useRequestStore.getState().openTab({ title: 'First', filePath: '/ws/requests/first.http' })
    useRequestStore.getState().openTab({ title: 'Second', filePath: '/ws/requests/second.http' })
    renderTabBar()

    const firstTab = tabElement('First')
    act(() => {
      firstTab.dispatchEvent(
        new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
      )
    })

    expect(useRequestStore.getState().tabs.map((t) => t.title)).toEqual(['Second'])
  })

  it('closes a pinned tab on middle-click and ignores non-middle auxclick', () => {
    useRequestStore.getState().openTab({ title: 'Pinned', filePath: '/ws/requests/pinned.http' })
    const pinnedId = useRequestStore.getState().tabs[0].id
    useRequestStore.getState().pinTab(pinnedId)
    renderTabBar()

    const tab = tabElement('Pinned')
    act(() => {
      tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))
    })
    expect(useRequestStore.getState().tabs).toHaveLength(1)

    act(() => {
      tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    })
    expect(useRequestStore.getState().tabs).toHaveLength(0)
  })

  it('prompts confirmation before closing a dirty tab on middle-click', () => {
    useRequestStore.getState().openTab({ title: 'Dirty', filePath: '/ws/requests/dirty.http' })
    const dirtyId = useRequestStore.getState().tabs[0].id
    useRequestStore.getState().updateTab(dirtyId, { isDirty: true })
    renderTabBar()

    const tab = tabElement('Dirty')
    act(() => {
      tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    })

    expect(useRequestStore.getState().tabs).toHaveLength(1)
    expect(document.body.textContent).toContain('closeConfirm.title')
  })
})
