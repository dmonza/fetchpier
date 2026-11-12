/**
 * Passive security findings — the response viewer's Security panel and badge
 * (CA-24 model, CA-25, CA-26 copy, CA-27). Asserts the DOM through i18n keys, not
 * the pixels; the rendered journey is FIND-012..014.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Finding, FindingsEvaluation } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { SecurityTab, securityBadge } from './SecurityTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function render(props: Partial<Parameters<typeof SecurityTab>[0]> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root!.render(
      <SecurityTab
        enabled
        error={null}
        onOpenSettings={() => {}}
        emptyState={<p>idle-placeholder</p>}
        {...props}
      />
    )
  )
  return container
}

const finding = (ruleId: string, severity: Finding['severity'], evidence = {}): Finding => ({
  ruleId,
  severity,
  category: ruleId.split('.')[0] as Finding['category'],
  evidence
})

const evaluated = (
  items: Finding[],
  over: Partial<Extract<FindingsEvaluation, { status: 'evaluated' }>> = {}
): FindingsEvaluation => ({
  status: 'evaluated',
  items,
  rulesApplied: 14,
  tls: 'captured',
  finalOrigin: 'https://api.example',
  ...over
})

const infoHeading = (el: HTMLElement): string | null =>
  el.querySelector('[data-severity-group="info"] h3')!.textContent

describe('securityBadge', () => {
  it.each([
    ['no evaluation', undefined, null],
    ['a failed evaluation', { status: 'failed' } as FindingsEvaluation, null],
    ['no findings', evaluated([]), null],
    ['info only', evaluated([finding('headers.version-disclosure', 'info')]), null],
    [
      'medium + info',
      evaluated([
        finding('headers.hsts-missing', 'medium'),
        finding('headers.version-disclosure', 'info')
      ]),
      { count: 1, tone: 'warning' }
    ],
    [
      'high + low',
      evaluated([finding('tls.legacy-protocol', 'high'), finding('headers.csp-missing', 'low')]),
      { count: 2, tone: 'danger' }
    ],
    ['low only', evaluated([finding('headers.csp-missing', 'low')]), { count: 1, tone: 'neutral' }]
  ])('%s → %o', (_label, findings, expected) => {
    expect(securityBadge(findings)).toEqual(expected)
  })
})

describe('SecurityTab states', () => {
  it('turned off: says so and offers the workspace settings', () => {
    const onOpenSettings = vi.fn()
    const el = render({ enabled: false, findings: evaluated([]), onOpenSettings })
    expect(el.textContent).toContain('response.security.turnedOff')
    const button = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('response.security.openSettings')
    )
    act(() => button!.click())
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('no findings: names how many rules were applied, and nothing else', () => {
    const el = render({ findings: evaluated([], { rulesApplied: 3 }) })
    expect(el.textContent).toContain('response.security.noFindings:{"n":3}')
    expect(el.querySelectorAll('[data-finding]')).toHaveLength(0)
  })

  it('lists findings grouped by severity, most severe first, each with its texts', () => {
    const el = render({
      findings: evaluated([
        finding('tls.legacy-protocol', 'high', { protocol: 'TLSv1.1' }),
        finding('headers.hsts-missing', 'medium'),
        finding('headers.version-disclosure', 'info', { header: 'Server' })
      ])
    })
    const groups = [...el.querySelectorAll('[data-severity-group]')].map((g) =>
      g.getAttribute('data-severity-group')
    )
    expect(groups).toEqual(['high', 'medium', 'info'])
    const row = el.querySelector('[data-finding="tls.legacy-protocol"]')!
    expect(row.textContent).toContain('findings.rules.tls.legacy-protocol.title')
    expect(row.textContent).toContain('findings.rules.tls.legacy-protocol.rationale')
    expect(row.textContent).toContain('findings.rules.tls.legacy-protocol.reference')
    expect(row.textContent).toContain('TLSv1.1')
    expect(row.textContent).toContain('findings.severity.high')
  })

  it('TLS details unavailable: one info row, with the other findings still listed', () => {
    const el = render({
      findings: evaluated([finding('headers.nosniff-missing', 'low')], { tls: 'unavailable' })
    })
    expect(el.textContent).toContain('response.security.tlsUnavailable')
    expect(el.querySelector('[data-finding="headers.nosniff-missing"]')).not.toBeNull()
    expect(infoHeading(el)).toBe('findings.severityGroup.info:{"count":1}')
    expect(el.querySelector('[data-severity-group="low"] h3')!.textContent).toBe(
      'findings.severityGroup.low:{"count":1}'
    )
  })

  it('TLS details unavailable with no findings: the row and the no-findings copy', () => {
    const el = render({ findings: evaluated([], { tls: 'unavailable', rulesApplied: 9 }) })
    expect(el.textContent).toContain('response.security.tlsUnavailable')
    expect(el.textContent).toContain('response.security.noFindings:{"n":9}')
    expect(infoHeading(el)).toBe('findings.severityGroup.info:{"count":1}')
  })

  it('TLS details unavailable beside an info finding: the Info heading counts both rows', () => {
    const el = render({
      findings: evaluated([finding('headers.version-disclosure', 'info')], { tls: 'unavailable' })
    })
    expect(el.querySelectorAll('[data-severity-group="info"] li')).toHaveLength(2)
    expect(infoHeading(el)).toBe('findings.severityGroup.info:{"count":2}')
  })

  it('evaluation failed', () => {
    const el = render({ findings: { status: 'failed' } })
    expect(el.textContent).toContain('response.security.evaluationFailed')
  })

  it('no response: the send failed before one arrived', () => {
    const el = render({ error: 'connect ECONNREFUSED' })
    expect(el.textContent).toContain('response.security.noResponse')
  })

  it('idle: the viewer’s usual placeholder', () => {
    expect(render().textContent).toContain('idle-placeholder')
  })

  it('never claims a verdict: no success styling on an empty result', () => {
    const el = render({ findings: evaluated([]) })
    expect(el.innerHTML).not.toMatch(/success/)
  })
})
