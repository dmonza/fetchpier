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
import { useTreeFilterStore } from '../../stores/treeFilter'
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

function setUp(): void {
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
}

function tearDown(): void {
  act(() => {
    useTreeStateStore.getState().clear()
    root.unmount()
  })
  container.remove()
  document.body.replaceChildren()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).api
}

async function renderTree(tree: WorkspaceTree[] = SAMPLE_TREE): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    filesystem: {
      readTree: vi.fn(async () => tree),
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

function treeItems(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
}

function treeContainer(): HTMLElement {
  return container.querySelector<HTMLElement>('[role="tree"]')!
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
    setUp()
    await renderTree()
  })

  afterEach(tearDown)

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

const FILTER_TREE: WorkspaceTree[] = [
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

describe('CollectionTree — sidebar search', () => {
  beforeEach(setUp)
  afterEach(tearDown)

  it('filters the tree, auto-expands matching branches without mutating persisted state, and clears', async () => {
    await renderTree(FILTER_TREE)
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

  it('highlights the matching part of each matching name', async () => {
    await renderTree(FILTER_TREE)
    typeInto(searchInput(), 'a1')
    const marks = [...treeItem('reqA1').querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toEqual(['A1'])
    // A folder kept only because a child matched is not highlighted.
    expect(treeItem('folderA').querySelector('mark')).toBeNull()
  })

  it('ArrowDown in the field moves keyboard focus to the first visible row', async () => {
    await renderTree(FILTER_TREE)
    typeInto(searchInput(), 'reqA1')
    searchInput().focus()
    act(() => {
      searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(useTreeSelectionStore.getState().focusedPath).toBe('/ws/requests/folderA')
    expect(document.activeElement).toBe(treeItem('folderA'))
  })

  it('Escape in an empty field moves keyboard focus to the tree', async () => {
    await renderTree(FILTER_TREE)
    searchInput().focus()
    act(() => {
      searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(treeContainer().contains(document.activeElement)).toBe(true)
  })

  it('a focus request (shortcut or menu) focuses the field, also one made before mounting', async () => {
    act(() => useTreeFilterStore.getState().requestFocus())
    await renderTree(FILTER_TREE)
    expect(document.activeElement).toBe(searchInput())
    expect(useTreeFilterStore.getState().focusRequested).toBe(false)

    treeItem('folderA').focus()
    act(() => useTreeFilterStore.getState().requestFocus())
    expect(document.activeElement).toBe(searchInput())
  })
})

describe('CollectionTree — a toolbar create always shows its name input', () => {
  beforeEach(setUp)
  afterEach(tearDown)

  const nameInput = (): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>('input[placeholder="collection.newRequestName"]')

  function startToolbarCreate(): void {
    act(() => {
      root.render(<CollectionTree pendingRootCreate="request" onClearRootCreate={() => {}} />)
    })
  }

  it('expands the selected folder when it is collapsed', async () => {
    await renderTree(FILTER_TREE)
    act(() => treeItem('folderA').click()) // select + expand
    act(() => treeItem('folderA').click()) // stays selected, collapses
    expect(useTreeStateStore.getState().isExpanded('/ws/requests/folderA')).toBe(false)

    startToolbarCreate()
    expect(useTreeStateStore.getState().isExpanded('/ws/requests/folderA')).toBe(true)
    expect(nameInput()).not.toBeNull()
  })

  it('clears a filter that hides the selected folder', async () => {
    await renderTree(FILTER_TREE)
    act(() => treeItem('folderA').click())
    typeInto(searchInput(), 'reqRoot')
    expect(treeItems().map((el) => el.textContent?.trim())).toEqual(['reqRoot'])

    startToolbarCreate()
    expect(searchInput().value).toBe('')
    expect(nameInput()).not.toBeNull()
  })
})
