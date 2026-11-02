/**
 * The environment-management panel's left-hand list: row context menu, inline
 * rename, inline duplicate and the delete confirmation dialog
 * (ENV-ROW-001..006 in the test catalog).
 *
 * The identity rules the operations rest on (folder derivation, uniqueness,
 * rename/duplicate semantics) are proven in the business layer — this file
 * asserts only what needs the rendered list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Environment } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { EnvironmentList } from './EnvironmentList'

const ENVS: Environment[] = [
  { id: 'id-a', folder: 'staging', name: 'Staging', variables: {} },
  { id: 'id-b', folder: 'dev-qa', name: 'Dev QA', variables: {} }
]

let container: HTMLDivElement
let root: Root

function render(props: Partial<React.ComponentProps<typeof EnvironmentList>> = {}): {
  onSelect: ReturnType<typeof vi.fn>
  onRename: ReturnType<typeof vi.fn>
  onDuplicate: ReturnType<typeof vi.fn>
  onDelete: ReturnType<typeof vi.fn>
  onCreate: ReturnType<typeof vi.fn>
} {
  const handlers = {
    onSelect: vi.fn(),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDuplicate: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onCreate: vi.fn().mockResolvedValue(undefined)
  }
  act(() => {
    root.render(<EnvironmentList environments={ENVS} selectedId="id-a" {...handlers} {...props} />)
  })
  return handlers
}

/** The row `<button>` whose visible text is the environment's display name. */
function row(name: string): HTMLElement {
  const found = [...container.querySelectorAll('[data-env-row]')].find((el) =>
    el.textContent?.includes(name)
  )
  if (!found) throw new Error(`row not found: ${name}`)
  return found as HTMLElement
}

/** The display names of the rows currently rendered, in render order. */
function rowNames(): string[] {
  return [...container.querySelectorAll('[data-env-row]')].map((el) => el.textContent ?? '')
}

function searchInput(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[data-env-search]')
  if (!el) throw new Error('search input not found')
  return el
}

function sortButton(mode: 'asc' | 'desc'): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-env-sort="${mode}"]`)
  if (!el) throw new Error(`sort button not found: ${mode}`)
  return el
}

const pressedSort = (): string[] =>
  [...container.querySelectorAll('[data-env-sort][aria-pressed="true"]')].map(
    (el) => el.getAttribute('data-env-sort') ?? ''
  )

function openMenu(name: string): void {
  act(() => {
    row(name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
  })
}

function menuItem(key: string): HTMLElement {
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  const found = items.find((el) => el.textContent === key)
  if (!found)
    throw new Error(
      `menu item not found: ${key} (have: ${items.map((i) => i.textContent).join(', ')})`
    )
  return found as HTMLElement
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressKey(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

const inlineInput = (): HTMLInputElement | null => container.querySelector('input[data-env-inline]')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  // Radix portals its menu/dialog layers onto <body>; drop whatever is left.
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('EnvironmentList — row context menu (CA-12, CA-13)', () => {
  it('offers exactly rename, duplicate and delete (CA-12)', () => {
    render()
    openMenu('Staging')
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)
    expect(labels).toEqual([
      'environment.contextMenu.rename',
      'environment.contextMenu.duplicate',
      'environment.contextMenu.delete'
    ])
  })

  it('renders no icon on a row in any state (CA-12, §9.2 op-check 5)', () => {
    render()
    // Text only: the hover trash affordance is gone and nothing replaced it.
    expect(container.querySelectorAll('[data-env-row] svg')).toHaveLength(0)
    act(() => {
      row('Staging').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      row('Staging').dispatchEvent(new FocusEvent('focus', { bubbles: true }))
    })
    expect(container.querySelectorAll('[data-env-row] svg')).toHaveLength(0)
  })

  it('selects the row it opens on (ENV-ROW-002)', () => {
    const { onSelect } = render()
    openMenu('Dev QA')
    expect(onSelect).toHaveBeenCalledWith('id-b')
    // The menu is still the one the row owns — selecting did not replace it.
    expect([...document.querySelectorAll('[role="menuitem"]')]).toHaveLength(3)
  })

  it('left-click still selects', () => {
    const { onSelect } = render()
    click(row('Dev QA'))
    expect(onSelect).toHaveBeenCalledWith('id-b')
  })
})

describe('EnvironmentList — search and sort (ENV-ROW-010, ENV-ROW-011)', () => {
  const MANY: Environment[] = [
    { id: 'id-s', folder: 'staging', name: 'Staging', variables: {} },
    { id: 'id-p', folder: 'produccion', name: 'Producción', variables: {} },
    { id: 'id-b', folder: 'dev-qa', name: 'Dev QA', variables: {} }
  ]

  it('opens alphabetically, with that mode marked active', () => {
    render({ environments: MANY })
    expect(rowNames()).toEqual(['Dev QA', 'Producción', 'Staging'])
    expect(pressedSort()).toEqual(['asc'])
  })

  it('offers exactly A → Z and Z → A, marking only the chosen one', () => {
    render({ environments: MANY })
    expect(
      [...container.querySelectorAll('[data-env-sort]')].map((el) => el.textContent)
    ).toHaveLength(2)

    click(sortButton('desc'))
    expect(rowNames()).toEqual(['Staging', 'Producción', 'Dev QA'])
    expect(pressedSort()).toEqual(['desc'])

    click(sortButton('asc'))
    expect(rowNames()).toEqual(['Dev QA', 'Producción', 'Staging'])
    expect(pressedSort()).toEqual(['asc'])
  })

  it('filters as the user types and restores the list when cleared', () => {
    render({ environments: MANY })

    typeInto(searchInput(), 'produccion')
    expect(rowNames()).toEqual(['Producción'])

    typeInto(searchInput(), '')
    expect(rowNames()).toEqual(['Dev QA', 'Producción', 'Staging'])
  })

  it('says nothing matched, and still offers the create field', () => {
    render({ environments: MANY })
    typeInto(searchInput(), 'zzz')

    expect(rowNames()).toEqual([])
    expect(container.textContent).toContain('environment.noMatches')
    expect(container.querySelector('input[placeholder="environment.newNamePlaceholder"]')).not.toBe(
      null
    )
  })

  it('keeps a rejected inline rename visible when the query stops matching it', async () => {
    const onRename = vi
      .fn()
      .mockRejectedValue(
        new Error('ENVIRONMENT_NAME_CONFLICT: folder "dev-qa" is already used by "Dev QA"')
      )
    render({ environments: MANY, onRename })

    openMenu('Staging')
    click(menuItem('environment.contextMenu.rename'))
    typeInto(inlineInput()!, 'Dev QA')
    await act(async () => {
      inlineInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    typeInto(searchInput(), 'dev')

    // The row being edited survives the filter with its typed text and its error;
    // the ones that neither match nor are being edited do not.
    expect(inlineInput()!.value).toBe('Dev QA')
    expect(container.textContent).toContain('environment.errors.folderConflict')
    expect(rowNames()).toEqual(['Dev QA'])
  })
})

describe('EnvironmentList — inline rename (CA-05, §6.4)', () => {
  it('opens pre-filled with the current display name', () => {
    render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.rename'))
    expect(inlineInput()?.value).toBe('Staging')
  })

  it('commits on Enter', () => {
    const { onRename } = render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.rename'))
    typeInto(inlineInput()!, 'Producción')
    pressKey(inlineInput()!, 'Enter')
    expect(onRename).toHaveBeenCalledWith('id-a', 'Producción')
  })

  it('discards on Escape', () => {
    const { onRename } = render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.rename'))
    typeInto(inlineInput()!, 'Producción')
    pressKey(inlineInput()!, 'Escape')
    expect(onRename).not.toHaveBeenCalled()
    expect(inlineInput()).toBeNull()
  })

  // The panel is itself a dialog, and Radix dismisses a dialog on a document-level
  // Escape. An Escape that cancels the inline editor must not also tear the panel
  // down — the user asked to abandon a rename, not to close the editor.
  it('does not let Escape or Enter escape the inline editor', () => {
    render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.rename'))

    const seen: string[] = []
    const listener = (e: Event): void => {
      seen.push((e as KeyboardEvent).key)
    }
    document.addEventListener('keydown', listener)
    try {
      pressKey(inlineInput()!, 'Escape')
      expect(seen).toEqual([])

      openMenu('Staging')
      click(menuItem('environment.contextMenu.rename'))
      pressKey(inlineInput()!, 'Enter')
      expect(seen).toEqual([])
    } finally {
      document.removeEventListener('keydown', listener)
    }
  })

  it('an empty value discards', () => {
    const { onRename } = render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.rename'))
    typeInto(inlineInput()!, '   ')
    pressKey(inlineInput()!, 'Enter')
    expect(onRename).not.toHaveBeenCalled()
    expect(inlineInput()).toBeNull()
  })

  it('keeps the field open with the typed text and shows the error when rejected (CA-05)', async () => {
    const onRename = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'ENVIRONMENT_NAME_CONFLICT: folder "dev-qa" is already used by environment "Dev QA"'
        )
      )
    render({ onRename })
    openMenu('Staging')
    click(menuItem('environment.contextMenu.rename'))
    typeInto(inlineInput()!, 'Dev QA')
    await act(async () => {
      inlineInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // The user corrects rather than retypes.
    expect(inlineInput()).not.toBeNull()
    expect(inlineInput()!.value).toBe('Dev QA')
    expect(container.textContent).toContain('environment.errors.folderConflict')
  })
})

describe('EnvironmentList — inline duplicate (CA-10, CA-11, §6.5)', () => {
  it('pre-fills the first free copy name (CA-11)', () => {
    render({
      environments: [
        { id: 'id-a', folder: 'staging', name: 'staging', variables: {} },
        { id: 'id-c', folder: 'staging-copy', name: 'staging-copy', variables: {} }
      ]
    })
    openMenu('staging')
    click(menuItem('environment.contextMenu.duplicate'))
    expect(inlineInput()?.value).toBe('staging-copy-2')
  })

  it('writes nothing until the name is confirmed (CA-10)', () => {
    const { onDuplicate } = render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.duplicate'))
    expect(onDuplicate).not.toHaveBeenCalled()
    pressKey(inlineInput()!, 'Escape')
    expect(onDuplicate).not.toHaveBeenCalled()
    expect(inlineInput()).toBeNull()
  })

  it('commits the typed name', () => {
    const { onDuplicate } = render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.duplicate'))
    pressKey(inlineInput()!, 'Enter')
    expect(onDuplicate).toHaveBeenCalledWith('id-a', 'Staging-copy')
  })

  it('renders the input as a new row while the source row stays visible', () => {
    render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.duplicate'))
    expect(container.textContent).toContain('Staging')
    expect(container.querySelectorAll('[data-env-row]')).toHaveLength(ENVS.length)
  })
})

describe('EnvironmentList — delete (CA-14, §6.6)', () => {
  it('confirms in a dialog naming the environment and its machine-local state', () => {
    render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.delete'))
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('environment.deleteConfirm')
    expect(dialog!.textContent).toContain('Staging')
  })

  it('deletes on confirm', () => {
    const { onDelete } = render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.delete'))
    const confirm = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'collection.delete.confirm'
    )
    click(confirm as HTMLElement)
    expect(onDelete).toHaveBeenCalledWith('id-a')
  })

  it('does nothing on cancel', () => {
    const { onDelete } = render()
    openMenu('Staging')
    click(menuItem('environment.contextMenu.delete'))
    const cancel = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'collection.delete.cancel'
    )
    click(cancel as HTMLElement)
    expect(onDelete).not.toHaveBeenCalled()
  })
})
