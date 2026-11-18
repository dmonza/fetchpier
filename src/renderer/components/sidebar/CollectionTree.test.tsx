import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, WorkspaceTree } from '../../../shared/types'

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
  },
  {
    name: 'folderB',
    path: '/ws/requests/folderB',
    type: 'folder',
    kind: 'folder',
    children: []
  }
]

const FOLDER_A = '/ws/requests/folderA'

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

function treeContainer(): HTMLElement {
  return container.querySelector<HTMLElement>('[role="tree"]')!
}

/** Open the row's context menu; Radix renders its items in a portal on document.body. */
function openContextMenu(label: string): HTMLElement[] {
  act(() => {
    treeItem(label).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    )
  })
  const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  if (items.length === 0) throw new Error(`context menu did not open on: ${label}`)
  return items
}

function selection(): { selectedPath: string | null; focusedPath: string | null } {
  const { selectedPath, focusedPath } = useTreeSelectionStore.getState()
  return { selectedPath, focusedPath }
}

describe('CollectionTree — selection and deselection', () => {
  beforeEach(async () => {
    // jsdom has no layout: the tree scrolls the keyboard-focused row into view.
    Element.prototype.scrollIntoView = vi.fn()
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
    await renderTree()
  })

  afterEach(() => {
    act(() => {
      useTreeStateStore.getState().clear()
      root.unmount()
    })
    container.remove()
    document.body.replaceChildren()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
  })

  it('a second click on the selected folder keeps it selected and only toggles it', () => {
    act(() => treeItem('folderA').click())
    expect(useTreeStateStore.getState().isExpanded(FOLDER_A)).toBe(true)

    act(() => treeItem('folderA').click())
    expect(selection().selectedPath).toBe(FOLDER_A)
    expect(useTreeStateStore.getState().isExpanded(FOLDER_A)).toBe(false)
  })

  it('a click on the empty area clears selection and focus', () => {
    act(() => treeItem('folderA').click())
    act(() => {
      treeContainer().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(selection()).toEqual({ selectedPath: null, focusedPath: null })
  })

  it('Escape on the tree clears selection and focus, and keeps keyboard focus in the tree', () => {
    act(() => treeItem('folderA').click())
    treeItem('folderA').focus()
    act(() => {
      treeItem('folderA').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    expect(selection()).toEqual({ selectedPath: null, focusedPath: null })
    expect(treeContainer().contains(document.activeElement)).toBe(true)
  })

  describe('the open request mark', () => {
    const REQ = '/ws/requests/folderA/reqA1.http'

    function openTab(id: string, filePath: string): void {
      act(() => {
        useRequestStore.setState({
          tabs: [{ id, title: id, filePath } as unknown as Tab],
          activeTabId: id,
          mruIds: [id]
        })
      })
    }

    const marked = (): boolean => treeItem('reqA1').className.includes('bg-primary-tint')

    beforeEach(() => {
      act(() => treeItem('folderA').click()) // expand so the request row renders
      openTab('t1', REQ)
    })

    it('an empty-area click hides it until the active tab changes', () => {
      expect(marked()).toBe(true)
      act(() => {
        treeContainer().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(marked()).toBe(false)
      openTab('t2', REQ)
      expect(marked()).toBe(true)
    })

    it('Escape hides it; selecting a folder keeps it hidden, clicking the request shows it', () => {
      act(() => {
        treeItem('folderA').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      })
      expect(marked()).toBe(false)
      act(() => treeItem('folderB').click())
      expect(useTreeSelectionStore.getState().selectedPath).toBe('/ws/requests/folderB')
      expect(marked()).toBe(false)
      act(() => treeItem('reqA1').click())
      expect(marked()).toBe(true)
    })
  })

  it('choosing a context-menu item on another row keeps the selection', () => {
    act(() => treeItem('folderA').click())
    const rename = openContextMenu('folderB').find(
      (i) => i.textContent === 'collection.contextMenu.rename'
    )!
    act(() => rename.click())
    expect(selection().selectedPath).toBe(FOLDER_A)
  })

  it('Escape that closes the context menu keeps the selection', () => {
    act(() => treeItem('folderA').click())
    const [first] = openContextMenu('folderA')
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
    expect(selection().selectedPath).toBe(FOLDER_A)
  })
})
