import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WorkspaceTree } from '../../../shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../i18n', () => ({ default: {} }))
vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { CollectionTree } from './CollectionTree'
import { useRequestStore } from '../../stores/request'
import { useTreeSelectionStore } from '../../stores/treeSelection'
import { useTreeStateStore } from '../../stores/treeState'
import { useWorkspaceStore } from '../../stores/workspace'

const SAMPLE_TREE: WorkspaceTree[] = [
  {
    name: 'folderA',
    path: '/ws/requests/folderA',
    type: 'folder',
    kind: 'folder',
    children: [
      {
        name: 'reqA1.http',
        path: '/ws/requests/folderA/reqA1.http',
        type: 'file',
        kind: 'request'
      },
      {
        name: 'reqA2.http',
        path: '/ws/requests/folderA/reqA2.http',
        type: 'file',
        kind: 'request'
      }
    ]
  },
  { name: 'reqRoot.http', path: '/ws/requests/reqRoot.http', type: 'file', kind: 'request' }
]

let container: HTMLDivElement
let root: Root

async function renderTree(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    filesystem: {
      readTree: vi.fn(async () => SAMPLE_TREE),
      onChange: vi.fn(() => () => {}),
      checkName: vi.fn(async () => ({ available: true }))
    },
    treeState: {
      read: vi.fn(async () => []),
      write: vi.fn(async () => undefined)
    }
  }
  await act(async () => {
    root.render(<CollectionTree />)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function treeItems(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
}

function searchInput(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[data-collection-search]')
  if (!el) throw new Error('search input not found')
  return el
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('CollectionTree — sidebar search', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useWorkspaceStore.setState({ workspacePath: '/ws', requestsRoot: '/ws/requests' })
    useRequestStore.setState({ tabs: [], activeTabId: null, mruIds: [] })
    useTreeSelectionStore.getState().clear()
    useTreeStateStore.setState({
      workspacePath: '/ws',
      expanded: new Set(),
      ready: true,
      seedPending: false,
      pendingFolderPaths: null,
      pendingExpandablePaths: null,
      lastFolderKeys: []
    })
  })

  afterEach(() => {
    act(() => {
      useTreeStateStore.getState().clear()
      root.unmount()
    })
    container.remove()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
  })

  it('filters the tree, auto-expands matching branches without mutating persisted state, and clears', async () => {
    await renderTree()
    expect(treeItems().map((el) => el.textContent?.trim())).toEqual(['folderA', 'reqRoot'])

    typeInto(searchInput(), 'reqA1')
    expect(treeItems().map((el) => el.textContent?.trim())).toEqual(['folderA', 'reqA1'])
    expect(useTreeStateStore.getState().isExpanded('/ws/requests/folderA')).toBe(false)

    act(() => {
      searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(searchInput().value).toBe('')
    expect(treeItems().map((el) => el.textContent?.trim())).toEqual(['folderA', 'reqRoot'])

    typeInto(searchInput(), 'missing')
    expect(treeItems()).toHaveLength(0)
    expect(container.textContent).toContain('sidebar.noSearchResults')

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="sidebar.searchClear"]')!
        .click()
    })
    expect(searchInput().value).toBe('')
  })
})
