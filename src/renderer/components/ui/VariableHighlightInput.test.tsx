import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// React 19 requires this flag for act(...) to flush state updates from events.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({
    t: (key: string) => key
  })
}))

import { VariableHighlightInput } from './VariableHighlightInput'

interface Mounted {
  container: HTMLDivElement
  root: Root
  input: HTMLInputElement
  onChange: ReturnType<typeof vi.fn>
}

async function mount(value: string, variables: Record<string, string | null>): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onChange = vi.fn()
  await act(async () => {
    root.render(<VariableHighlightInput value={value} variables={variables} onChange={onChange} />)
  })
  const input = container.querySelector('input') as HTMLInputElement
  return { container, root, input, onChange }
}

/** Place the caret and fire focus so the suggestion popup opens. */
async function openSuggestions(input: HTMLInputElement, caret: number): Promise<void> {
  input.setSelectionRange(caret, caret)
  await act(async () => {
    // React delegates onFocus to the bubbling `focusin` event.
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
}

async function clickSuggestion(_container: HTMLDivElement, name: string): Promise<void> {
  // REQ-0094: the suggestion overlay is portaled to document.body, so query there.
  const button = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(name)
  )
  if (!button) throw new Error(`suggestion button for "${name}" not found`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

describe('VariableHighlightInput — variable suggestion', () => {
  let root: Root
  let container: HTMLDivElement

  afterEach(() => {
    if (root && container) {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('offers plain and secret names with a secret indicator and no value preview (CA-06)', async () => {
    let input: HTMLInputElement
    ;({ container, root, input } = await mount('{{', {
      baseUrl: 'https://api.example.com',
      apiKey: 'enc:v1:ciphertext',
      pending: null
    }))
    await openSuggestions(input, 2)

    // REQ-0094: suggestions render in a document.body portal, not inside the field.
    expect(document.body.textContent).toContain('baseUrl')
    expect(document.body.textContent).toContain('apiKey')
    expect(document.body.textContent).toContain('pending')

    // No value of any kind is previewed.
    expect(document.body.textContent).not.toContain('https://api.example.com')
    expect(document.body.textContent).not.toContain('enc:v1')

    // Secret entries (apiKey, pending) carry the secret indicator; plain does not.
    const indicators = document.body.querySelectorAll(
      '[aria-label="request.variableSuggestion.secret"]'
    )
    expect(indicators).toHaveLength(2)
  })

  it('never offers a $env.* entry (CA-07)', async () => {
    let input: HTMLInputElement
    ;({ container, root, input } = await mount('{{', {
      apiKey: '{{$env.OPENAI_KEY}}'
    }))
    await openSuggestions(input, 2)

    expect(document.body.textContent).toContain('apiKey')
    expect(document.body.textContent).not.toContain('$env')
  })

  // REQ-0094: the suggestion overlay must render outside the field's container —
  // portaled to document.body — so no ancestor's `overflow` can clip it and no
  // sibling panel/modal can paint over it. Asserting the portal is the deterministic
  // proxy for "always above all layers" (z-index/clipping aren't meaningful in jsdom).
  it('renders the suggestion overlay outside the field container (portaled) (REQ-0094)', async () => {
    let input: HTMLInputElement
    ;({ container, root, input } = await mount('{{', { baseUrl: 'x' }))
    await openSuggestions(input, 2)

    const button = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('baseUrl')
    )
    expect(button).toBeDefined()
    // The overlay lives in document.body but NOT inside the field's own container.
    expect(container.contains(button as Node)).toBe(false)
  })

  it('inserts a closed placeholder on selection (CA-08, no pre-existing close)', async () => {
    let input: HTMLInputElement
    let onChange: ReturnType<typeof vi.fn>
    ;({ container, root, input, onChange } = await mount('{{', { baseUrl: 'x' }))
    await openSuggestions(input, 2)
    await clickSuggestion(container, 'baseUrl')

    const lastValue = onChange.mock.calls.at(-1)?.[0].target.value
    expect(lastValue).toBe('{{baseUrl}}')
  })

  it('is idempotent against an already-closed placeholder (CA-08 / §6.2)', async () => {
    let input: HTMLInputElement
    let onChange: ReturnType<typeof vi.fn>
    // caret between the braces: `{{|}}`
    ;({ container, root, input, onChange } = await mount('{{}}', { baseUrl: 'x' }))
    await openSuggestions(input, 2)
    await clickSuggestion(container, 'baseUrl')

    const lastValue = onChange.mock.calls.at(-1)?.[0].target.value
    expect(lastValue).toBe('{{baseUrl}}')
  })

  it('offers the dynamic variables even when the environment is empty (REQ-0087)', async () => {
    let input: HTMLInputElement
    ;({ container, root, input } = await mount('{{', {}))
    await openSuggestions(input, 2)
    // The popup is no longer empty: the system dynamic variables are always offered.
    expect(document.body.querySelector('button')).not.toBeNull()
    expect(document.body.textContent).toContain('$guid')
    // They carry the dedicated dynamic indicator, not the secret key.
    expect(
      document.body.querySelectorAll('[aria-label="request.variableSuggestion.dynamic"]').length
    ).toBeGreaterThan(0)
    expect(
      document.body.querySelector('[aria-label="request.variableSuggestion.secret"]')
    ).toBeNull()
  })

  it('marks a dynamic suggestion with the dynamic indicator (REQ-0087 CA-08)', async () => {
    let input: HTMLInputElement
    ;({ container, root, input } = await mount('{{$', { baseUrl: 'x' }))
    await openSuggestions(input, 3)
    // Typing `$` filters to dynamic only.
    expect(document.body.textContent).toContain('$guid')
    expect(document.body.textContent).not.toContain('baseUrl')
  })

  // REQ-0087 CA-10: the inline overlay paints a recognized dynamic token in a
  // third state, distinct from resolved (env value) and missing (unknown).
  it('highlights a dynamic token in the dynamic state, vs found vs missing (CA-10)', async () => {
    ;({ container, root } = await mount('{{baseUrl}} {{$guid}} {{$nope}}', { baseUrl: 'x' }))
    const overlay = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(overlay).not.toBeNull()
    const classFor = (token: string): string =>
      [...overlay.querySelectorAll('span')].find((s) => s.textContent === token)?.className ?? ''
    expect(classFor('{{baseUrl}}')).toContain('text-var-resolved')
    expect(classFor('{{$guid}}')).toContain('fp-var-dynamic-fg')
    expect(classFor('{{$nope}}')).toContain('text-var-missing')
  })
})

// ── REQ-0089: secret masking with brief last-char reveal ──────────────────────

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.setSelectionRange(value.length, value.length)
}

/** Controlled harness so onChange updates the value (mirrors a real consumer). */
function SecretHarness(props: {
  initial: string
  variables?: Record<string, string | null>
  secret?: boolean
}): React.JSX.Element {
  const [v, setV] = useState(props.initial)
  return (
    <VariableHighlightInput
      secret={props.secret}
      value={v}
      variables={props.variables}
      onChange={(e) => setV(e.target.value)}
    />
  )
}

describe('VariableHighlightInput — secret masking (REQ-0089)', () => {
  let root: Root
  let container: HTMLDivElement

  function mountSecret(
    initial: string,
    opts: { variables?: Record<string, string | null> } = {}
  ): {
    input: HTMLInputElement
    overlay: () => HTMLElement
  } {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<SecretHarness initial={initial} secret variables={opts.variables} />)
    })
    const input = container.querySelector('input') as HTMLInputElement
    return { input, overlay: () => container.querySelector('[aria-hidden="true"]') as HTMLElement }
  }

  afterEach(() => {
    vi.useRealTimers()
    if (root && container) {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('masks a literal value as dots and uses a password input', () => {
    const { input, overlay } = mountSecret('abc', { variables: {} })
    expect(overlay().textContent).toBe('•••')
    expect(overlay().textContent).not.toContain('abc')
    expect(input.getAttribute('type')).toBe('password')
  })

  it('briefly reveals the last typed character, then re-masks', () => {
    vi.useFakeTimers()
    const { input, overlay } = mountSecret('ab', { variables: {} })
    act(() => {
      setNativeValue(input, 'abc')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Last char is visible immediately after typing…
    expect(overlay().textContent).toBe('••c')
    // …and masks once the reveal window elapses.
    act(() => {
      vi.advanceTimersByTime(800)
    })
    expect(overlay().textContent).toBe('•••')
  })

  it('does not reveal on deletion', () => {
    vi.useFakeTimers()
    const { input, overlay } = mountSecret('abc', { variables: {} })
    act(() => {
      setNativeValue(input, 'ab')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(overlay().textContent).toBe('••')
  })

  it('shows a {{variable}} reference in clear text when variable-capable', () => {
    const { input, overlay } = mountSecret('{{cert_pass}}', { variables: { cert_pass: 'enc:x' } })
    expect(overlay().textContent).toContain('{{cert_pass}}')
    // A visible reference is not masked, so the input is a text field.
    expect(input.getAttribute('type')).toBe('text')
  })

  it('masks everything — including {{...}} — for a pure secret (no variables passed)', () => {
    const { overlay } = mountSecret('{{x}}')
    expect(overlay().textContent).toBe('•••••')
    expect(overlay().textContent).not.toContain('{{x}}')
  })

  // REQ-0090: clear text only for a *complete* reference — anything else is masked.
  it('masks a literal that begins with a brace (CA-01)', () => {
    const { input, overlay } = mountSecret('{p@ss}', { variables: { cert_pass: 'enc:x' } })
    expect(overlay().textContent).toBe('••••••')
    expect(overlay().textContent).not.toContain('{p@ss}')
    expect(input.getAttribute('type')).toBe('password')
  })

  it('masks a reference carrying surrounding literal text (CA-03)', () => {
    const { input, overlay } = mountSecret('{{cert_pass}}tail', {
      variables: { cert_pass: 'enc:x' }
    })
    expect(input.getAttribute('type')).toBe('password')
    expect(overlay().textContent).not.toContain('{{cert_pass}}')
    expect(overlay().textContent).toBe('•'.repeat('{{cert_pass}}tail'.length))
  })

  it('keeps an in-progress {{ reference masked while suggestions still work (CA-04)', async () => {
    const { input, overlay } = mountSecret('{{', { variables: { cert_pass: 'enc:x' } })
    // An incomplete reference is masked…
    expect(input.getAttribute('type')).toBe('password')
    expect(overlay().textContent).toBe('••')
    // …yet the {{-suggestion still opens (it reads the value, not the masked display).
    await openSuggestions(input, 2)
    const hasSuggestion = [...document.body.querySelectorAll('button')].some((b) =>
      b.textContent?.includes('cert_pass')
    )
    expect(hasSuggestion).toBe(true)
  })
})
