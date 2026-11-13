import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BinaryFileAttachment } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): {
    t: (k: string, opts?: Record<string, unknown>) => string
  } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { BinaryBodyPicker } from './BinaryBodyPicker'

interface BinaryApiMock {
  selectAndStage: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
}

function setupApi(): BinaryApiMock {
  const api: BinaryApiMock = {
    selectAndStage: vi.fn(),
    stat: vi.fn().mockResolvedValue({ exists: true, sizeBytes: 1024, mimeType: 'text/plain' }),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    list: vi.fn().mockResolvedValue([])
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = { binary: api }
  return api
}

async function mount(props: {
  binaryFile?: BinaryFileAttachment
  workspacePath: string | null
  onChange?: (v: BinaryFileAttachment | undefined) => void
  readOnly?: boolean
}): Promise<{ container: HTMLDivElement; root: Root; onChange: ReturnType<typeof vi.fn> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onChange = vi.fn(props.onChange)
  await act(async () => {
    root.render(
      <BinaryBodyPicker
        binaryFile={props.binaryFile}
        workspacePath={props.workspacePath}
        onChange={onChange}
        readOnly={props.readOnly}
      />
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return { container, root, onChange }
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => root.unmount())
  container.remove()
}

const STAGED: BinaryFileAttachment = {
  ref: 'a'.repeat(64) + '__report.pdf',
  originalName: 'report.pdf',
  sizeBytes: 1024,
  mimeType: 'application/pdf'
}

describe('BinaryBodyPicker', () => {
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

  it('renders the choose-file button when no file is staged', async () => {
    ;({ container, root } = await mount({ binaryFile: undefined, workspacePath: '/ws' }))
    const button = container.querySelector('button')
    expect(button?.textContent).toContain('request.body.binary.chooseFile')
  })

  it('disables the choose-file button when there is no workspace', async () => {
    ;({ container, root } = await mount({ binaryFile: undefined, workspacePath: null }))
    const button = container.querySelector<HTMLButtonElement>('button')
    expect(button?.disabled).toBe(true)
  })

  it('renders the staged file metadata when a file is attached', async () => {
    ;({ container, root } = await mount({ binaryFile: STAGED, workspacePath: '/ws' }))
    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).toContain('request.body.binary.replace')
  })

  it('invokes onChange(undefined) when the remove button is clicked', async () => {
    let onChange: ReturnType<typeof vi.fn>
    ;({ container, root, onChange } = await mount({
      binaryFile: STAGED,
      workspacePath: '/ws'
    }))
    const removeBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="request.body.binary.remove"]'
    )
    expect(removeBtn).not.toBeNull()
    await act(async () => {
      removeBtn!.click()
    })
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('opens the picker on trigger click; "Select local file…" runs selectAndStage', async () => {
    let onChange: ReturnType<typeof vi.fn>
    ;({ container, root, onChange } = await mount({
      binaryFile: undefined,
      workspacePath: '/ws'
    }))
    const api = (window as unknown as { api: { binary: BinaryApiMock } }).api.binary
    api.selectAndStage.mockResolvedValueOnce({
      status: 'staged',
      ref: STAGED.ref,
      originalName: STAGED.originalName,
      sizeBytes: STAGED.sizeBytes,
      mimeType: STAGED.mimeType
    })
    // Click the chooseFile trigger → opens the dropdown (does NOT call selectAndStage).
    const trigger = container.querySelector<HTMLButtonElement>('button')
    await act(async () => {
      trigger!.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.selectAndStage).not.toHaveBeenCalled()
    // Find and click "Select local file…" in the footer (panel lives in document.body via portal).
    const footer = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.includes('request.body.binary.picker.selectLocal')
    )
    expect(footer).toBeDefined()
    await act(async () => {
      footer!.click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // UI-06: the native picker's title is resolved here, through t().
    expect(api.selectAndStage).toHaveBeenCalledWith({
      sourcePath: undefined,
      confirmed: undefined,
      title: 'request.body.binary.pickerTitle'
    })
    expect(onChange).toHaveBeenCalledWith(STAGED)
  })

  it('picking an entry from the dropdown emits the attachment without re-staging', async () => {
    let onChange: ReturnType<typeof vi.fn>
    const api = (window as unknown as { api: { binary: BinaryApiMock } }).api?.binary
    if (api) {
      api.list.mockResolvedValueOnce([{ ...STAGED, mtimeMs: 1000 }])
    }
    // Re-setup to use the entry we want.
    ;({ container, root, onChange } = await mount({
      binaryFile: undefined,
      workspacePath: '/ws'
    }))
    const apiNow = (window as unknown as { api: { binary: BinaryApiMock } }).api.binary
    apiNow.list.mockResolvedValueOnce([{ ...STAGED, mtimeMs: 1000 }])
    const trigger = container.querySelector<HTMLButtonElement>('button')
    await act(async () => {
      trigger!.click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const option = document.body.querySelector<HTMLButtonElement>('button[role="option"]')
    expect(option).not.toBeNull()
    await act(async () => {
      option!.click()
    })
    expect(apiNow.selectAndStage).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(STAGED)
  })

  it('flags missing-on-disk via stat()', async () => {
    const api = (window as unknown as { api: { binary: BinaryApiMock } }).api.binary
    api.stat.mockResolvedValueOnce({ exists: false })
    ;({ container, root } = await mount({ binaryFile: STAGED, workspacePath: '/ws' }))
    // The missing-banner shows the i18n key with interpolated ref.
    expect(container.textContent).toContain('request.body.binary.fileMissing')
  })
})
