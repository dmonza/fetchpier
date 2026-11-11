/**
 * Passive security findings — the Workspace Settings section (CA-21 and §6.10):
 * what it shows, and the exact block it hands back to be saved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FindingsSettings } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { FindingsSettingsSection } from './FindingsSettingsSection'
import { FINDING_RULES } from '../../../shared/lib/findings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function render(value: FindingsSettings | undefined, onChange = vi.fn()): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<FindingsSettingsSection value={value} onChange={onChange} />))
  return container
}

const ruleSwitch = (el: HTMLElement, id: string): HTMLButtonElement =>
  el.querySelector(`[data-rule="${id}"] [role="switch"]`) as HTMLButtonElement

function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('FindingsSettingsSection', () => {
  it('lists every rule, grouped by category, with its severity', () => {
    const el = render(undefined)
    expect(el.querySelectorAll('[data-rule]')).toHaveLength(FINDING_RULES.length)
    const categories = [...el.querySelectorAll('[data-category]')].map((c) =>
      c.getAttribute('data-category')
    )
    expect(categories).toEqual(['transport', 'tls', 'headers', 'cookies', 'auth', 'cache'])
    const row = el.querySelector('[data-rule="tls.legacy-protocol"]')!
    expect(row.textContent).toContain('findings.rules.tls.legacy-protocol.title')
    expect(row.textContent).toContain('findings.severity.high')
  })

  it('turns findings off, keeping the rest of the block', () => {
    const onChange = vi.fn()
    const el = render({ disabledRules: ['headers.csp-missing'], certExpiryWarnDays: 7 }, onChange)
    const main = el.querySelector('[data-findings-enabled] [role="switch"]') as HTMLButtonElement
    expect(main.getAttribute('aria-checked')).toBe('true')
    act(() => main.click())
    expect(onChange).toHaveBeenCalledWith({
      enabled: false,
      disabledRules: ['headers.csp-missing'],
      certExpiryWarnDays: 7
    })
  })

  it('disables a rule while keeping an id this version does not know', () => {
    const onChange = vi.fn()
    const el = render({ disabledRules: ['future.rule'] }, onChange)
    act(() => ruleSwitch(el, 'headers.csp-missing').click())
    expect(onChange).toHaveBeenCalledWith({ disabledRules: ['future.rule', 'headers.csp-missing'] })
  })

  it('re-enables a disabled rule, still keeping the unknown id', () => {
    const onChange = vi.fn()
    const el = render({ disabledRules: ['headers.csp-missing', 'future.rule'] }, onChange)
    expect(ruleSwitch(el, 'headers.csp-missing').getAttribute('aria-checked')).toBe('false')
    act(() => ruleSwitch(el, 'headers.csp-missing').click())
    expect(onChange).toHaveBeenCalledWith({ disabledRules: ['future.rule'] })
  })

  it('lists the ids it does not recognize as ignored', () => {
    const el = render({ disabledRules: ['future.rule'] })
    const unknown = el.querySelector('[data-unknown-rules]')!
    expect(unknown.textContent).toContain('future.rule')
    expect(unknown.textContent).toContain('workspaceSettings.findings.unknownRules')
  })

  it('says which stored fields could not be used (a hand edit), without quoting them', () => {
    const el = render({ certExpiryWarnDays: -1, enabled: 'yes' as never })
    const note = el.querySelector('[data-invalid-fields]')!
    expect(note.textContent).toContain('workspaceSettings.findings.invalidFields')
    expect(note.textContent).toContain('enabled')
    expect(note.textContent).toContain('certExpiryWarnDays')
    expect(note.textContent).not.toContain('-1')
    expect(render(undefined).querySelector('[data-invalid-fields]')).toBeNull()
  })

  it('saves a valid expiry window and refuses an invalid one', () => {
    const onChange = vi.fn()
    const el = render(undefined, onChange)
    const input = el.querySelector('input[data-expiry]') as HTMLInputElement
    expect(input.value).toBe('30')
    for (const bad of ['-1', '1.5', '']) {
      type(input, bad)
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        'workspaceSettings.findings.expiryInvalid'
      )
    }
    expect(onChange).not.toHaveBeenCalled()
    type(input, '7')
    expect(onChange).toHaveBeenCalledWith({ certExpiryWarnDays: 7 })
    expect(el.querySelector('[role="alert"]')).toBeNull()
  })
})
