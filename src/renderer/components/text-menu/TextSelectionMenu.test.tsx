import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// React 19 requires this flag for act(...) to flush state updates from events.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))

import { TextSelectionMenu } from './TextSelectionMenu'

// Radix menus touch pointer-capture / scroll APIs jsdom lacks.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

let root: Root
let container: HTMLDivElement
let writeText: ReturnType<typeof vi.fn>
let readText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  readText = vi.fn().mockResolvedValue('clip')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText, readText }
  })
})

afterEach(() => {
  if (root && container) {
    act(() => root.unmount())
    container.remove()
  }
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<TextSelectionMenu />)
  })
}

/** Fire a right-click on `el`; optionally let an app menu pre-handle it. */
async function rightClick(el: Element, opts: { preHandled?: boolean } = {}): Promise<void> {
  if (opts.preHandled) {
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { once: true })
  }
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  // Flush the async clipboard read that sets `canPaste`.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function menuItems(): HTMLElement[] {
  return [...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
}

function itemByLabel(label: string): HTMLElement | undefined {
  return menuItems().find((i) => i.textContent === label)
}

function isDisabled(item: HTMLElement | undefined): boolean {
  return (
    !!item &&
    (item.getAttribute('data-disabled') !== null || item.getAttribute('aria-disabled') === 'true')
  )
}

function makeInput(value: string, readOnly = false): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  input.readOnly = readOnly
  document.body.appendChild(input)
  return input
}

function stubSelection(text: string): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => text,
    rangeCount: 0
  } as unknown as Selection)
}

describe('TextSelectionMenu', () => {
  it('shows Cut/Copy/Paste all enabled on an editable field with a selection (CA-02)', async () => {
    await mount()
    const input = makeInput('hello world')
    input.setSelectionRange(0, 5)
    await rightClick(input)

    expect(itemByLabel('textMenu.cut')).toBeDefined()
    expect(itemByLabel('textMenu.copy')).toBeDefined()
    expect(itemByLabel('textMenu.paste')).toBeDefined()
    expect(isDisabled(itemByLabel('textMenu.cut'))).toBe(false)
    expect(isDisabled(itemByLabel('textMenu.copy'))).toBe(false)
    expect(isDisabled(itemByLabel('textMenu.paste'))).toBe(false)
  })

  it('disables Cut/Copy without a selection; Paste enabled iff clipboard has text (CA-03)', async () => {
    await mount()
    const input = makeInput('hello')
    input.setSelectionRange(2, 2)
    await rightClick(input)

    expect(isDisabled(itemByLabel('textMenu.cut'))).toBe(true)
    expect(isDisabled(itemByLabel('textMenu.copy'))).toBe(true)
    expect(isDisabled(itemByLabel('textMenu.paste'))).toBe(false) // clipboard = 'clip'
  })

  it('disables Paste when the clipboard is empty (CA-03)', async () => {
    readText.mockResolvedValue('')
    await mount()
    const input = makeInput('hello')
    input.setSelectionRange(2, 2)
    await rightClick(input)

    expect(isDisabled(itemByLabel('textMenu.paste'))).toBe(true)
  })

  it('read-only selection → Copy enabled, Cut/Paste shown but disabled (CA-01)', async () => {
    await mount()
    const input = makeInput('readonly text', true)
    input.setSelectionRange(0, 8)
    await rightClick(input)

    expect(itemByLabel('textMenu.copy')).toBeDefined()
    expect(itemByLabel('textMenu.cut')).toBeDefined()
    expect(itemByLabel('textMenu.paste')).toBeDefined()
    expect(isDisabled(itemByLabel('textMenu.copy'))).toBe(false)
    expect(isDisabled(itemByLabel('textMenu.cut'))).toBe(true)
    expect(isDisabled(itemByLabel('textMenu.paste'))).toBe(true)
  })

  it('read-only CodeMirror (aria-readonly content) → Paste disabled, never reads clipboard (response body)', async () => {
    stubSelection('selected')
    await mount()
    // Read-only CodeMirror: `.cm-content` stays contenteditable=true but carries
    // aria-readonly=true. Paste must show disabled, not enabled.
    const cm = document.createElement('div')
    cm.setAttribute('contenteditable', 'true')
    cm.setAttribute('aria-readonly', 'true')
    document.body.appendChild(cm)
    await rightClick(cm)

    expect(isDisabled(itemByLabel('textMenu.copy'))).toBe(false)
    expect(isDisabled(itemByLabel('textMenu.paste'))).toBe(true)
    expect(readText).not.toHaveBeenCalled()
  })

  it('right-clicking a token inside a read-only CodeMirror with no selection shows no menu (response body bug)', async () => {
    stubSelection('')
    await mount()
    // The real right-click target is a highlight `<span>` with inherited
    // contentEditable; aria-readonly lives on the `.cm-content` ancestor.
    const content = document.createElement('div')
    content.setAttribute('contenteditable', 'true')
    content.setAttribute('aria-readonly', 'true')
    const token = document.createElement('span')
    content.appendChild(token)
    document.body.appendChild(content)
    Object.defineProperty(token, 'isContentEditable', { value: true, configurable: true })
    await rightClick(token)

    // Before the fix this surfaced an editable menu with Paste enabled.
    expect(menuItems()).toHaveLength(0)
  })

  it('shows nothing on a non-editable area with no selection (CA-04)', async () => {
    stubSelection('')
    await mount()
    const div = document.createElement('div')
    document.body.appendChild(div)
    await rightClick(div)

    expect(menuItems()).toHaveLength(0)
  })

  it('yields to an app menu that already handled the right-click (CA-05)', async () => {
    await mount()
    const input = makeInput('hello')
    input.setSelectionRange(0, 5)
    await rightClick(input, { preHandled: true })

    expect(menuItems()).toHaveLength(0)
  })

  it('appears in an inline rename/create input — a plain editable input (CA-06)', async () => {
    await mount()
    // The tree's inline rename input is a standalone editable <input>, not wrapped
    // in an app context menu, so the right-click falls through to the text menu.
    const input = makeInput('my-request')
    input.setSelectionRange(0, 2)
    await rightClick(input)

    expect(itemByLabel('textMenu.cut')).toBeDefined()
    expect(itemByLabel('textMenu.copy')).toBeDefined()
    expect(itemByLabel('textMenu.paste')).toBeDefined()
  })

  it('Copy writes the selection to the clipboard (CA-01)', async () => {
    await mount()
    const input = makeInput('hello world')
    input.setSelectionRange(6, 11) // "world"
    await rightClick(input)

    const copy = itemByLabel('textMenu.copy')!
    await act(async () => {
      copy.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(writeText).toHaveBeenCalledWith('world')
  })

  it('Paste updates the controlled field through its input path (CA-07)', async () => {
    readText.mockResolvedValue('XYZ')
    await mount()
    const input = makeInput('hello')
    input.setSelectionRange(2, 4) // "ll"
    const onInput = vi.fn()
    input.addEventListener('input', onInput)
    await rightClick(input)

    const paste = itemByLabel('textMenu.paste')!
    await act(async () => {
      paste.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(input.value).toBe('heXYZo')
    expect(onInput).toHaveBeenCalled()
  })

  it('returns focus to the field on close (so a later blur resolves an inline rename)', async () => {
    readText.mockResolvedValue('X')
    await mount()
    const input = makeInput('hello')
    input.focus()
    input.setSelectionRange(0, 0)
    await rightClick(input)

    const paste = itemByLabel('textMenu.paste')!
    await act(async () => {
      paste.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    // The focus-scope restores focus on unmount via a macrotask.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Without the onCloseAutoFocus override Radix would focus the invisible 0×0
    // trigger here, leaving the input unfocused and the rename stuck open.
    expect(document.activeElement).toBe(input)
  })
})
