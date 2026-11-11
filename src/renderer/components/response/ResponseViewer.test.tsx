/**
 * Passive security findings — how the response viewer offers the Security tab
 * (CA-27a, CA-28): always, with the same neutral shield, except on tabs opened
 * from history, which have no findings to show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab } from '../../../shared/types'
import { DEFAULT_REQUEST_STATE } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { ResponseViewer } from './ResponseViewer'
import { useRequestStore } from '../../stores/request'
import { useWorkspaceSettingsStore } from '../../stores/workspaceSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null
const baseSettings = useWorkspaceSettingsStore.getState().httpSettings

const tab = (over: Partial<Tab> = {}): Tab => ({
  id: 't1',
  title: 'get',
  filePath: null,
  isDirty: false,
  request: DEFAULT_REQUEST_STATE,
  response: null,
  isLoading: false,
  error: null,
  requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  mode: 'permanent',
  ...over
})

function render(t: Tab): HTMLDivElement {
  useRequestStore.setState({ tabs: [t], activeTabId: t.id })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ResponseViewer />))
  return container
}

const securityButton = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector('button[data-response-tab="security"]')

beforeEach(() => {
  useWorkspaceSettingsStore.setState({ httpSettings: baseSettings })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe('Security tab offer', () => {
  it('is offered before the first send, with a decorative shield before its label', () => {
    const button = securityButton(render(tab()))
    expect(button?.textContent).toContain('response.tabs.security')
    const icon = button?.querySelector('svg')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(button?.firstElementChild).toBe(icon)
  })

  it('is offered with the same shield when findings are turned off', () => {
    useWorkspaceSettingsStore.setState({
      httpSettings: { ...baseSettings, findings: { enabled: false } }
    })
    const first = securityButton(render(tab()))?.querySelector('svg')?.outerHTML
    act(() => root!.unmount())
    container?.remove()
    useWorkspaceSettingsStore.setState({ httpSettings: baseSettings })
    const second = securityButton(render(tab()))?.querySelector('svg')?.outerHTML
    expect(first).toBeDefined()
    expect(first).toBe(second)
  })

  it('is not offered on a tab opened from history, which falls back to Body', () => {
    const el = render(
      tab({ isReadOnly: true, historyEntryId: 'run-1', activeResponseTab: 'security' })
    )
    expect(securityButton(el)).toBeNull()
    const active = el.querySelector('button.border-primary')
    expect(active?.getAttribute('data-response-tab')).toBe('body')
    expect(el.textContent).not.toContain('response.security')
  })

  it('shows the badge only while findings are enabled', () => {
    const findings = {
      status: 'evaluated' as const,
      items: [
        {
          ruleId: 'headers.hsts-missing',
          severity: 'medium' as const,
          category: 'headers' as const,
          evidence: {}
        }
      ],
      rulesApplied: 14,
      tls: 'captured' as const,
      finalOrigin: 'https://api.example'
    }
    expect(securityButton(render(tab({ findings })))?.textContent).toContain('1')
    act(() => root!.unmount())
    container?.remove()
    useWorkspaceSettingsStore.setState({
      httpSettings: { ...baseSettings, findings: { enabled: false } }
    })
    expect(securityButton(render(tab({ findings })))?.textContent).not.toContain('1')
  })
})
