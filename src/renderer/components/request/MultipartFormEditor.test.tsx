import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MultipartPart } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): {
    t: (k: string, opts?: Record<string, unknown>) => string
  } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { MultipartFormEditor } from './MultipartFormEditor'

interface BinaryApiMock {
  selectAndStage: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
}

function setupApi(): BinaryApiMock {
  const api: BinaryApiMock = {
    selectAndStage: vi.fn(),
    stat: vi.fn().mockResolvedValue({ exists: true, sizeBytes: 100, mimeType: 'image/jpeg' }),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    list: vi.fn().mockResolvedValue([])
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = { binary: api }
  return api
}

async function mount(props: {
  parts: MultipartPart[]
  workspacePath: string | null
  readOnly?: boolean
}): Promise<{
  container: HTMLDivElement
  root: Root
  onChange: ReturnType<typeof vi.fn>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onChange = vi.fn()
  await act(async () => {
    root.render(
      <MultipartFormEditor
        parts={props.parts}
        workspacePath={props.workspacePath}
        onChange={onChange}
        readOnly={props.readOnly}
      />
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  return { container, root, onChange }
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => root.unmount())
  container.remove()
}

const HASH = 'a'.repeat(64)
const REF = `${HASH}__beach.jpg`

describe('MultipartFormEditor', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    setupApi()
  })

  afterEach(() => {
    if (root && container) unmount(root, container)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
  })

  it('renders the empty state when there are no parts', async () => {
    ;({ container, root } = await mount({ parts: [], workspacePath: '/ws' }))
    expect(container.textContent).toContain('request.body.multipart.noPartsYet')
    // Both add buttons present.
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons.some((b) => b?.includes('addTextPart'))).toBe(true)
    expect(buttons.some((b) => b?.includes('addFilePart'))).toBe(true)
  })

  it('disables the add-file button when no workspace is open', async () => {
    ;({ container, root } = await mount({ parts: [], workspacePath: null }))
    const fileButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.includes('addFilePart')
    )
    expect(fileButton?.disabled).toBe(true)
  })

  it('renders a text part row when one exists', async () => {
    const parts: MultipartPart[] = [{ kind: 'text', id: 'mp-0', name: 'field', value: 'hello' }]
    ;({ container, root } = await mount({ parts, workspacePath: '/ws' }))
    // Name and value inputs are addressable via aria-label.
    const nameInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="request.body.multipart.name"]'
    )
    expect(nameInput?.value).toBe('field')
    const valueInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="request.body.multipart.value"]'
    )
    expect(valueInput?.value).toBe('hello')
    // The Text/File dropdown is present and reflects the kind.
    const kindSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="request.body.multipart.kindSelect"]'
    )
    expect(kindSelect?.value).toBe('text')
  })

  it('renders a file part row with the original filename', async () => {
    const parts: MultipartPart[] = [
      {
        kind: 'file',
        id: 'mp-0',
        name: 'photo',
        file: { ref: REF, originalName: 'beach.jpg', sizeBytes: 100, mimeType: 'image/jpeg' }
      }
    ]
    ;({ container, root } = await mount({ parts, workspacePath: '/ws' }))
    expect(container.textContent).toContain('beach.jpg')
    const kindSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="request.body.multipart.kindSelect"]'
    )
    expect(kindSelect?.value).toBe('file')
  })

  it('calls onChange with one fewer part when removing', async () => {
    const parts: MultipartPart[] = [
      { kind: 'text', id: 'mp-0', name: 'a', value: 'A' },
      { kind: 'text', id: 'mp-1', name: 'b', value: 'B' }
    ]
    let onChange: ReturnType<typeof vi.fn>
    ;({ container, root, onChange } = await mount({ parts, workspacePath: '/ws' }))
    const removeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.getAttribute('aria-label') === 'keyValue.remove'
    )
    expect(removeBtn).toBeDefined()
    await act(async () => {
      removeBtn!.click()
    })
    expect(onChange).toHaveBeenCalledWith([parts[1]])
  })

  it('no longer renders move-up/move-down arrows (replaced by drag & drop, REQ-0079)', async () => {
    const parts: MultipartPart[] = [
      { kind: 'text', id: 'mp-0', name: 'a', value: 'A' },
      { kind: 'text', id: 'mp-1', name: 'b', value: 'B' }
    ]
    ;({ container, root } = await mount({ parts, workspacePath: '/ws' }))
    const labels = Array.from(container.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label')
    )
    expect(labels).not.toContain('keyValue.moveUp')
    expect(labels).not.toContain('keyValue.moveDown')
  })

  it('adds a text part when the add button is clicked', async () => {
    const parts: MultipartPart[] = [{ kind: 'text', id: 'mp-0', name: 'existing', value: 'X' }]
    let onChange: ReturnType<typeof vi.fn>
    ;({ container, root, onChange } = await mount({ parts, workspacePath: '/ws' }))
    const addText = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('addTextPart')
    )
    await act(async () => {
      addText!.click()
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as MultipartPart[]
    expect(next).toHaveLength(2)
    expect(next[1].kind).toBe('text')
    expect(next[1].name).toBe('')
  })

  it('toggles disabled via the row checkbox', async () => {
    const parts: MultipartPart[] = [{ kind: 'text', id: 'mp-0', name: 'a', value: 'A' }]
    let onChange: ReturnType<typeof vi.fn>
    ;({ container, root, onChange } = await mount({ parts, workspacePath: '/ws' }))
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox?.checked).toBe(true) // enabled when disabled is undefined
    await act(async () => {
      checkbox!.click()
    })
    expect(onChange).toHaveBeenCalledWith([
      { kind: 'text', id: 'mp-0', name: 'a', value: 'A', disabled: true }
    ])
  })

  it('switches a text part to a file part via the kind dropdown', async () => {
    const parts: MultipartPart[] = [{ kind: 'text', id: 'mp-0', name: 'doc', value: 'hello' }]
    let onChange: ReturnType<typeof vi.fn>
    ;({ container, root, onChange } = await mount({ parts, workspacePath: '/ws' }))
    const kindSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="request.body.multipart.kindSelect"]'
    )
    expect(kindSelect).toBeDefined()
    await act(async () => {
      kindSelect!.value = 'file'
      kindSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as MultipartPart[]
    expect(next[0].kind).toBe('file')
    expect(next[0].id).toBe('mp-0')
    expect(next[0].name).toBe('doc')
  })
})
