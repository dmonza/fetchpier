/**
 * REQ-0115 — the response viewer's Cookies section (COOKIE-006, COOKIE-007).
 *
 * Asserts the DOM, not the pixels: what the tables list, what the badge counts,
 * and that a refused cookie is explained rather than leaving an empty table with
 * no reason. The look of it — legibility of the mark in both themes at a narrow
 * width — stays a manual check in the plan, because no assertion captures it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CookieSnapshot, ExecutionWarning } from '../../../shared/types'

// Project convention: the key plus its interpolation payload, so a test can
// assert the values a message was built from without depending on the wording.
vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { CookiesTab, cookieRowCount, cookieWarningsOf } from './CookiesTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function render(props: Parameters<typeof CookiesTab>[0]): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<CookiesTab {...props} />))
  return container
}

const cookie = (over: Partial<CookieSnapshot> = {}): CookieSnapshot => ({
  name: 'sid',
  value: 'abc',
  domain: 'example.test',
  path: '/',
  expires: null,
  secure: false,
  httpOnly: false,
  sameSite: null,
  hostOnly: true,
  url: 'https://example.test/login',
  ...over
})

describe('cookieRowCount', () => {
  it('counts both directions, because the section lists both', () => {
    // A badge that disagrees with what the section shows is a bug report waiting
    // to happen — a send that attaches three and receives none must not read "0".
    expect(cookieRowCount({ sent: [cookie(), cookie()], received: [] })).toBe(2)
    expect(cookieRowCount({ sent: [], received: [cookie()] })).toBe(1)
    expect(cookieRowCount(undefined)).toBe(0)
  })
})

describe('cookieWarningsOf', () => {
  it('takes only the cookie families, leaving the others to their own surface', () => {
    const warnings: ExecutionWarning[] = [
      { code: 'UNRESOLVED_VARIABLE', name: 'token' },
      { code: 'COOKIE_REJECTED', name: 'sid', host: 'a.test', reason: 'PUBLIC_SUFFIX' },
      { code: 'MALFORMED_QUERY_ENCODING', rawKey: '%zz', index: 0 },
      { code: 'COOKIE_CROSS_SITE_INSECURE', name: 'x', host: 'a.test' }
    ]
    expect(cookieWarningsOf(warnings).map((w) => w.code)).toEqual([
      'COOKIE_REJECTED',
      'COOKIE_CROSS_SITE_INSECURE'
    ])
  })
})

describe('COOKIE-006 — the section reports the send', () => {
  it('lists both directions with the hop each cookie belongs to', () => {
    const el = render({
      cookies: {
        sent: [cookie({ name: 'carried', url: 'https://example.test/a' })],
        received: [cookie({ name: 'granted', url: 'https://other.test/b' })]
      }
    })
    const text = el.textContent ?? ''
    expect(text).toContain('carried')
    expect(text).toContain('granted')
    // The hop is what makes a multi-host chain readable; `domain` cannot stand
    // in for it once a Domain attribute is involved.
    expect(text).toContain('https://example.test/a')
    expect(text).toContain('https://other.test/b')
  })

  it('omits the hop column on a single-hop send, where it only repeats itself', () => {
    const el = render({
      cookies: { sent: [], received: [cookie({ url: 'https://example.test/x' })] }
    })
    expect(el.textContent).not.toContain('https://example.test/x')
  })

  it('shows every attribute the reference layout carries', () => {
    const el = render({
      cookies: {
        sent: [],
        received: [
          cookie({
            path: '/admin',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
            expires: '2030-06-01T12:00:00.000Z'
          })
        ]
      }
    })
    const text = el.textContent ?? ''
    expect(text).toContain('/admin')
    expect(text).toContain('Lax')
    // Booleans are rendered as words, matching how the attributes read on the wire.
    expect(text).toContain('true')
  })

  it('labels a cookie with no expiry as a session cookie rather than leaving it blank', () => {
    const el = render({ cookies: { sent: [], received: [cookie({ expires: null })] } })
    expect(el.textContent).toContain('response.cookies.session')
  })

  it('marks a domain cookie with the conventional leading dot', () => {
    const el = render({
      cookies: { sent: [], received: [cookie({ domain: 'example.test', hostOnly: false })] }
    })
    expect(el.textContent).toContain('.example.test')
  })

  it('shows an empty state when the send touched no cookies at all', () => {
    const el = render({ cookies: { sent: [], received: [] } })
    expect(el.querySelectorAll('table')).toHaveLength(0)
  })

  it('distinguishes "nothing sent" from "nothing received"', () => {
    const el = render({ cookies: { sent: [cookie()], received: [] } })
    // One table for the direction that has rows, and a stated reason for the
    // other — rather than a single ambiguous blank.
    expect(el.querySelectorAll('table')).toHaveLength(1)
    expect(el.textContent).toContain('response.cookies.noneReceived')
  })
})

describe('COOKIE-009 — every column stays reachable', () => {
  it('renders a width for every column so none is sized by its content', () => {
    // The defect: without declared widths the browser sizes columns to content,
    // one long value stretches the table, and the trailing columns fall off the
    // right edge. A <col> per column is what pins them.
    const el = render({ cookies: { sent: [], received: [cookie()] } })
    const cols = el.querySelectorAll('colgroup col')
    const headers = el.querySelectorAll('thead th')
    expect(cols).toHaveLength(headers.length)
    for (const col of Array.from(cols)) {
      expect((col as HTMLElement).style.width).not.toBe('')
    }
  })

  it('gives the boolean columns less width than the free-text ones', () => {
    const el = render({ cookies: { sent: [], received: [cookie()] } })
    const widths = Array.from(el.querySelectorAll('colgroup col')).map((c) =>
      parseInt((c as HTMLElement).style.width, 10)
    )
    // Order is name, value, domain, path, expires, httpOnly, secure, sameSite.
    const [name, value, , , , httpOnly, secure] = widths
    expect(httpOnly).toBeLessThan(name)
    expect(secure).toBeLessThan(value)
  })

  it('puts a handle on every border between columns, and none on the trailing edge', () => {
    // The last column has no neighbour to trade width with, so a handle there
    // could only push the table past its container.
    const el = render({ cookies: { sent: [], received: [cookie()] } })
    const headers = el.querySelectorAll('thead th').length
    expect(el.querySelectorAll('thead th [role="separator"]')).toHaveLength(headers - 1)
  })

  /** Widths of the first table's columns, in order. */
  const colWidths = (el: HTMLElement): number[] =>
    Array.from(el.querySelectorAll('table:first-of-type colgroup col')).map((c) =>
      parseInt((c as HTMLElement).style.width, 10)
    )

  const drag = (el: HTMLElement, handleIndex: number, dxs: number[]): void => {
    const handle = el.querySelectorAll('thead th [role="separator"]')[handleIndex] as HTMLElement
    let x = 500
    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, bubbles: true }))
    })
    act(() => {
      for (const dx of dxs) {
        x += dx
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, bubbles: true }))
      }
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, bubbles: true }))
    })
  }

  it('moves the border: the left column takes exactly what the right one gives up', () => {
    // The regression this exists for: the handle reported an *incremental* delta
    // while the caller added it to a base captured at pointer-down, so every move
    // recomputed roughly the original width and the border never moved. Asserting
    // that handles merely exist would not have caught it.
    const el = render({ cookies: { sent: [], received: [cookie()] } })
    const before = colWidths(el)

    drag(el, 0, [40, 40])

    const after = colWidths(el)
    // Two moves of +40: the deltas accumulate rather than overwrite.
    expect(after[0]).toBe(before[0] + 80)
    expect(after[1]).toBe(before[1] - 80)
  })

  it('keeps the total width pinned to the container', () => {
    // The whole point of the paired model: the table must never outgrow its
    // panel, so no drag may change the sum.
    const el = render({ cookies: { sent: [], received: [cookie()] } })
    const total = (ws: number[]): number => ws.reduce((a, b) => a + b, 0)
    const before = total(colWidths(el))

    drag(el, 0, [120])
    expect(total(colWidths(el))).toBe(before)

    drag(el, 2, [-90])
    expect(total(colWidths(el))).toBe(before)
  })

  it('stops resizing once the pointer is released', () => {
    const el = render({ cookies: { sent: [], received: [cookie()] } })
    drag(el, 0, [50])
    const settled = colWidths(el)

    // A stray move after release must not keep resizing — the listener has to be
    // gone, not merely ignored.
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 4000, bubbles: true }))
    })
    expect(colWidths(el)).toEqual(settled)
  })

  it('stops at the minimum instead of squeezing a column to nothing', () => {
    const el = render({ cookies: { sent: [], received: [cookie()] } })
    const before = colWidths(el)

    // Far past what the left column can give up.
    drag(el, 0, [-5000])
    const after = colWidths(el)

    expect(after[0]).toBe(44)
    // Everything the left column lost went to its neighbour, nowhere else.
    expect(after[1]).toBe(before[1] + (before[0] - 44))
  })

  it('keeps the full value reachable when a cell is truncated', () => {
    // Truncation must never be the only copy of what the server sent.
    const long = 'x'.repeat(300)
    const el = render({ cookies: { sent: [], received: [cookie({ value: long })] } })
    const cells = Array.from(el.querySelectorAll('tbody td'))
    expect(cells.some((td) => td.getAttribute('title') === long)).toBe(true)
  })

  it('counts each direction in its own heading', () => {
    // The badge totals both directions; without a per-section count, "5" next to
    // "the response offered no cookies" reads as a contradiction.
    const el = render({
      cookies: { sent: [cookie(), cookie({ name: 'b' })], received: [] }
    })
    expect(el.textContent).toContain('(2)')
    expect(el.textContent).toContain('(0)')
  })
})

describe('COOKIE-007 — a refused cookie is explained', () => {
  it('renders the reason alongside the cookie and the host that offered it', () => {
    const el = render({
      cookies: { sent: [], received: [] },
      warnings: [
        { code: 'COOKIE_REJECTED', name: 'sid', host: 'attacker.test', reason: 'DOMAIN_MISMATCH' }
      ]
    })
    const text = el.textContent ?? ''
    // The empty state must NOT win here: an empty table with no explanation is
    // exactly the silence this change exists to remove.
    expect(text).not.toContain('response.cookies.empty')
    expect(text).toContain('sid')
    expect(text).toContain('attacker.test')
    expect(text).toContain('DOMAIN_MISMATCH')
  })

  it('still lists a cookie the jar refused, rather than hiding it', () => {
    // The whole point of the "offered" model: the server sent this, which is
    // observable fact. Hiding it because we chose not to keep it is the tool
    // withholding what it plainly saw.
    const el = render({
      cookies: { sent: [], received: [cookie({ name: 'refused', stored: false })] },
      warnings: [
        { code: 'COOKIE_REJECTED', name: 'refused', host: 'example.test', reason: 'PUBLIC_SUFFIX' }
      ]
    })
    expect(el.textContent).toContain('refused')
    expect(el.querySelectorAll('table')).toHaveLength(1)
  })

  it('renders the cross-site advisory for a cookie that was stored anyway', () => {
    const el = render({
      cookies: { sent: [], received: [cookie({ name: 'wide' })] },
      warnings: [{ code: 'COOKIE_CROSS_SITE_INSECURE', name: 'wide', host: 'example.test' }]
    })
    expect(el.textContent).toContain('crossSiteInsecure')
    // Stored means it is also listed, not only warned about.
    expect(el.querySelectorAll('table')).toHaveLength(1)
  })

  it('ignores warning families that belong to another surface', () => {
    const el = render({
      cookies: { sent: [], received: [] },
      warnings: [{ code: 'UNRESOLVED_VARIABLE', name: 'token' }]
    })
    expect(el.textContent).toContain('response.cookies.empty')
  })
})
