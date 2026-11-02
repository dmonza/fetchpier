import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StagedBinaryEntry } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): {
    t: (k: string, opts?: Record<string, unknown>) => string
  } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { StagedFilePicker } from './StagedFilePicker'

interface BinaryApiMock {
  list: ReturnType<typeof vi.fn>
}

function setupApi(entries: StagedBinaryEntry[]): BinaryApiMock {
  const api: BinaryApiMock = {
    list: vi.fn().mockResolvedValue(entries)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = { binary: api }
  return api
}

interface MountResult {
  container: HTMLDivElement
  root: Root
  onPick: ReturnType<typeof vi.fn>
  onStageNew: ReturnType<typeof vi.fn>
}

async function mount(opts: {
  entries: StagedBinaryEntry[]
  workspacePath?: string | null
  readOnly?: boolean
}): Promise<MountResult> {
  setupApi(opts.entries)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onPick = vi.fn()
  const onStageNew = vi.fn()
  await act(async () => {
    root.render(
      <StagedFilePicker
        workspacePath={opts.workspacePath ?? '/ws'}
        trigger={(p) => (
          <button {...p} type="button">
            open
          </button>
        )}
        onPick={onPick}
        onStageNew={onStageNew}
        readOnly={opts.readOnly}
      />
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  return { container, root, onPick, onStageNew }
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => root.unmount())
  container.remove()
}

// React tracks input values via a hidden setter; firing an `input` event
// without going through it is a no-op for React. This helper updates the
// value through the native setter so React picks it up.
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const ENTRY_A: StagedBinaryEntry = {
  ref: `${HASH_A}__photo.png`,
  originalName: 'photo.png',
  sizeBytes: 1024,
  mimeType: 'image/png',
  mtimeMs: 2000
}
const ENTRY_B: StagedBinaryEntry = {
  ref: `${HASH_B}__document.pdf`,
  originalName: 'document.pdf',
  sizeBytes: 50000,
  mimeType: 'application/pdf',
  mtimeMs: 1000
}

describe('StagedFilePicker', () => {
  let root: Root
  let container: HTMLDivElement

  afterEach(() => {
    if (root && container) unmount(root, container)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
  })

  it('renders only the trigger when closed', async () => {
    ;({ container, root } = await mount({ entries: [ENTRY_A] }))
    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('open')
  })

  it('opens the panel, fetches the list and renders entries without the hash', async () => {
    ;({ container, root } = await mount({ entries: [ENTRY_A, ENTRY_B] }))
    const api = (window as unknown as { api: { binary: BinaryApiMock } }).api.binary
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      trigger.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.list).toHaveBeenCalledWith()
    // Panel lives in document.body via portal.
    const panel = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('photo.png')
    expect(panel.textContent).toContain('document.pdf')
    expect(panel.textContent).not.toContain(HASH_A)
    expect(panel.textContent).not.toContain(HASH_B)
  })

  it('filters the list by the search query', async () => {
    ;({ container, root } = await mount({ entries: [ENTRY_A, ENTRY_B] }))
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      trigger.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const search = document.body.querySelector<HTMLInputElement>(
      'input[type="text"][aria-label="request.body.binary.picker.searchPlaceholder"]'
    )!
    await act(async () => {
      setInputValue(search, 'doc')
    })
    const panel = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(panel.textContent).toContain('document.pdf')
    expect(panel.textContent).not.toContain('photo.png')
  })

  it('shows the empty message when no entries match', async () => {
    ;({ container, root } = await mount({ entries: [] }))
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      trigger.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const panel = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(panel.textContent).toContain('request.body.binary.picker.empty')
  })

  it('calls onPick with a BinaryFileAttachment (no mtimeMs) and closes the panel', async () => {
    let onPick: ReturnType<typeof vi.fn>
    ;({ container, root, onPick } = await mount({ entries: [ENTRY_A] }))
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      trigger.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const row = document.body.querySelector<HTMLButtonElement>('button[role="option"]')!
    await act(async () => {
      row.click()
    })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith({
      ref: ENTRY_A.ref,
      originalName: 'photo.png',
      sizeBytes: 1024,
      mimeType: 'image/png'
    })
    // Panel removed from the DOM.
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('calls onStageNew when the footer button is clicked', async () => {
    let onStageNew: ReturnType<typeof vi.fn>
    ;({ container, root, onStageNew } = await mount({ entries: [] }))
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      trigger.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const panel = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const footerBtn = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('request.body.binary.picker.selectLocal')
    )
    expect(footerBtn).toBeDefined()
    await act(async () => {
      footerBtn!.click()
    })
    expect(onStageNew).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', async () => {
    ;({ container, root } = await mount({ entries: [ENTRY_A] }))
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      trigger.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not open when readOnly', async () => {
    ;({ container, root } = await mount({ entries: [ENTRY_A], readOnly: true }))
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      trigger.click()
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})
