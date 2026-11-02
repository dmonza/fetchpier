import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { KeyValuePair } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))

import { KeyValueEditor } from './KeyValueEditor'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  if (host) host.remove()
  root = null
  host = null
})

async function mount(
  pairs: KeyValuePair[],
  onChange: (p: KeyValuePair[]) => void
): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<KeyValueEditor pairs={pairs} onChange={onChange} />)
  })
  return host
}

/** Drive a React controlled <input> the way the browser would. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('KeyValueEditor — malformed flag clears on edit (REQ-0086)', () => {
  // CA-06: editing a malformed param expresses the intended value; the flag clears
  // so the param is persisted on save instead of being dropped.
  it('CA-06: editing the key clears the malformed flag', async () => {
    const onChange = vi.fn()
    const container = await mount(
      [{ id: 'p1', key: '%E0', value: 'v', enabled: true, malformed: true }],
      onChange
    )
    const textInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])')
    )
    expect(textInputs.length).toBeGreaterThanOrEqual(1)

    typeInto(textInputs[0], 'fixed')

    expect(onChange).toHaveBeenCalled()
    const lastArg = onChange.mock.calls.at(-1)![0] as KeyValuePair[]
    expect(lastArg[0]).toMatchObject({ key: 'fixed', malformed: false })
  })
})

// ── Value-less query parameters (REQ-0124) ──────────────────────────────────
// The two cells make different statements: the value cell is the only surface
// that says a value exists, so using it clears the mark; the key cell says
// nothing about values, so renaming a flag must not add an `=`.

describe('KeyValueEditor — value-less flag lifecycle (REQ-0124)', () => {
  function cells(container: HTMLElement): HTMLInputElement[] {
    return Array.from(container.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])'))
  }

  it('editing the value clears the flag — and it stays clear when emptied again', async () => {
    const onChange = vi.fn()
    const pair: KeyValuePair = { id: 'p1', key: 'wsdl', value: '', enabled: true, valueless: true }
    const container = await mount([pair], onChange)

    typeInto(cells(container)[1], 'x')
    const afterType = onChange.mock.calls.at(-1)![0] as KeyValuePair[]
    expect(afterType[0]).toMatchObject({ key: 'wsdl', value: 'x', valueless: false })

    // Re-mount with the produced state and clear the cell: the flag must NOT return.
    const onChange2 = vi.fn()
    const container2 = await mount(afterType, onChange2)
    typeInto(cells(container2)[1], '')
    const afterClear = onChange2.mock.calls.at(-1)![0] as KeyValuePair[]
    expect(afterClear[0]).toMatchObject({ key: 'wsdl', value: '', valueless: false })
  })

  it('editing the key preserves the flag', async () => {
    const onChange = vi.fn()
    const container = await mount(
      [{ id: 'p1', key: 'wsdl', value: '', enabled: true, valueless: true }],
      onChange
    )

    typeInto(cells(container)[0], 'servicio')

    const lastArg = onChange.mock.calls.at(-1)![0] as KeyValuePair[]
    expect(lastArg[0]).toMatchObject({ key: 'servicio', value: '', valueless: true })
  })

  it('still clears the malformed flag when the value is edited', async () => {
    const onChange = vi.fn()
    const container = await mount(
      [{ id: 'p1', key: 'k', value: '%E0', enabled: true, malformed: true }],
      onChange
    )

    typeInto(cells(container)[1], 'fixed')

    const lastArg = onChange.mock.calls.at(-1)![0] as KeyValuePair[]
    expect(lastArg[0]).toMatchObject({ value: 'fixed', malformed: false })
  })

  it('renders a value-less row and an empty-valued row identically (no marker)', async () => {
    const container = await mount(
      [
        { id: 'p1', key: 'pretty', value: '', enabled: true, valueless: true },
        { id: 'p2', key: 'page', value: '', enabled: true }
      ],
      vi.fn()
    )
    const [flagValue, plainValue] = [cells(container)[1], cells(container)[3]]
    expect(flagValue.value).toBe(plainValue.value)
    expect(flagValue.placeholder).toBe(plainValue.placeholder)
    expect(flagValue.className).toBe(plainValue.className)
  })
})
