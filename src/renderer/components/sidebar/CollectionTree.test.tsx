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
      }
    ]
  }
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

function treeItem(label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (el) => el.textContent?.trim() === label
  )
  if (!found) throw new Error(`treeitem not found: ${label}`)
  return found
}

describe('CollectionTree — folder deselection', () => {
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

  it('deselects a selected folder on second click, empty-area click, or Escape', async () => {
    await renderTree()

    act(() => {
      treeItem('folderA').click()
    })
    expect(useTreeSelectionStore.getState().selectedPath).toBe('/ws/requests/folderA')

    act(() => {
      treeItem('folderA').click()
    })
    expect(useTreeSelectionStore.getState().selectedPath).toBeNull()

    act(() => {
      treeItem('folderA').click()
    })
    const treeContainer = container.querySelector<HTMLElement>('[role="tree"]')!
    act(() => {
      treeContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useTreeSelectionStore.getState().selectedPath).toBeNull()

    act(() => {
      treeItem('folderA').click()
    })
    act(() => {
      treeContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
  })
})
