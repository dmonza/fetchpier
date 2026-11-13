import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Cookie } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, o?: { count?: number }) => string } => ({
    t: (key: string, o?: { count?: number }) => (o?.count !== undefined ? `${key}:${o.count}` : key)
  })
}))

const h = vi.hoisted(() => ({
  cookies: [] as Cookie[],
  loadError: null as string | null,
  remove: async (): Promise<void> => {}
}))

vi.mock('../../stores/cookies', () => {
  const state = {
    get cookies() {
      return h.cookies
    },
    get loadError() {
      return h.loadError
    },
    loadForEnvironment: async (): Promise<void> => {},
    clearAll: async (): Promise<void> => {},
    remove: (): Promise<void> => h.remove(),
    create: async (): Promise<void> => {},
    update: async (): Promise<void> => {}
  }
  return { useCookieStore: <T,>(sel: (s: typeof state) => T): T => sel(state) }
})

import { CookiesModal } from './CookiesModal'

const T0 = Date.parse('2026-06-01T12:00:00.000Z')
const iso = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString()

function makeCookie(overrides: Partial<Cookie> = {}): Cookie {
  return {
    id: 'c1',
    name: 'sid',
    value: 'abc',
    domain: 'example.com',
    path: '/',
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
    createdAt: iso(0),
    updatedAt: iso(0),
    source: 'response',
    ...overrides
  }
}

let root: Root | null = null

async function renderAt(nowOffsetSeconds: number, cookie: Cookie): Promise<HTMLTableRowElement> {
  vi.setSystemTime(T0 + nowOffsetSeconds * 1000)
  h.cookies = [cookie]
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <CookiesModal
        environmentId="env1"
        environmentName="dev"
        currentUrl="https://example.com/api"
        open
        onOpenChange={() => {}}
      />
    )
  })
  const row = [...document.body.querySelectorAll('tbody tr')].find((r) =>
    r.textContent?.includes('sid')
  )
  if (!row) throw new Error('cookie row not rendered')
  return row as HTMLTableRowElement
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
  h.loadError = null
  h.remove = async (): Promise<void> => {}
  vi.unstubAllGlobals()
})

// ENG-37: an unreadable jar file is reported in the panel, never shown as an
// empty jar the user would then "fill" over the stored cookies.
describe('CookiesModal — an unreadable jar', () => {
  const UNREADABLE = 'COOKIE_JAR_UNREADABLE: cannot read the cookie jar /ws/cookies.json: bad'

  it('explains a jar that failed to load', async () => {
    h.loadError = UNREADABLE
    await renderAt(0, makeCookie())
    expect(document.body.textContent).toContain('cookies.errors.jarUnreadable')
    expect(document.body.textContent).not.toContain('/ws/cookies.json')
  })

  it('offers Clear all over an unreadable, empty-looking jar', async () => {
    h.loadError = UNREADABLE
    h.cookies = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <CookiesModal environmentId="env1" environmentName="dev" open onOpenChange={() => {}} />
      )
    })
    const labels = [...document.body.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toContain('cookies.clearAll')
  })

  it('shows no error for a jar that loaded', async () => {
    await renderAt(0, makeCookie())
    expect(document.body.textContent).not.toContain('cookies.errors.jarUnreadable')
  })

  it('explains a delete the jar refused', async () => {
    h.remove = async (): Promise<void> => {
      throw new Error(UNREADABLE)
    }
    vi.stubGlobal('confirm', () => true)
    const row = await renderAt(0, makeCookie())
    const del = row.querySelector<HTMLButtonElement>('button[title="cookies.delete"]')!
    await act(async () => {
      del.click()
    })
    expect(document.body.textContent).toContain('cookies.errors.jarUnreadable')
  })
})

// UI-06: the Source column shows a translated label, never the raw enum value.
describe('CookiesModal — the cookie source badge is translated', () => {
  it.each([
    ['response', 'cookies.sourceResponse'],
    ['manual', 'cookies.sourceManual']
  ] as const)('a %s cookie is labelled %s', async (source, key) => {
    const row = await renderAt(0, makeCookie({ source }))
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent)
    expect(cells).toContain(key)
    expect(cells).not.toContain(source)
  })
})

// UI-02: the panel applies the jar's rule — a Max-Age lifetime runs from the
// last time the cookie was received (updatedAt), not from its first capture.
describe('CookiesModal — Max-Age measured from the last receipt', () => {
  // Set at T0 with Max-Age=600, refreshed by the server at T0+500 s: the jar
  // keeps sending it until T0+1100 s.
  const refreshed = makeCookie({ maxAge: 600, createdAt: iso(0), updatedAt: iso(500) })

  it('a refreshed cookie past its first window is not shown expired', async () => {
    const row = await renderAt(700, refreshed)
    expect(row.textContent).not.toContain('cookies.expired')
    expect(row.textContent).toContain('cookies.inSeconds:400')
    expect(row.className).not.toContain('opacity-60')
  })

  it('the countdown runs from the refresh, not from the first capture', async () => {
    const row = await renderAt(550, refreshed)
    expect(row.textContent).toContain('cookies.inSeconds:550')
  })

  it('is shown expired once Max-Age has elapsed since the refresh', async () => {
    const row = await renderAt(1100, refreshed)
    expect(row.textContent).toContain('cookies.expired')
    expect(row.className).toContain('opacity-60')
  })

  it('an Expires-only cookie still counts down to its absolute date', async () => {
    const row = await renderAt(
      100,
      makeCookie({ expires: iso(400), createdAt: iso(0), updatedAt: iso(50) })
    )
    expect(row.textContent).toContain('cookies.inSeconds:300')
  })
})
