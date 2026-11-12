import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Cookie } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))

const h = vi.hoisted(() => ({
  create: vi.fn(async (): Promise<void> => {}),
  update: vi.fn(async (): Promise<void> => {})
}))

vi.mock('../../stores/cookies', () => {
  const state = { create: h.create, update: h.update }
  return { useCookieStore: <T,>(sel: (s: typeof state) => T): T => sel(state) }
})

import { CookieForm } from './CookieForm'

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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'manual',
    ...overrides
  }
}

// UI-03 runs under a fixed non-UTC zone (UTC-3, no DST) so the offset the bug
// introduced is visible whatever zone the machine is in.
beforeAll(() => {
  vi.stubEnv('TZ', 'America/Argentina/Buenos_Aires')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

let root: Root | null = null

async function mount(cookie: Cookie | null): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<CookieForm cookie={cookie} environmentId="env1" onClose={() => {}} />)
  })
}

function expiresInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('input[type="datetime-local"]')
  if (!input) throw new Error('expiry input not rendered')
  return input
}

/** Set a controlled input's value the way a user edit reaches React. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function save(): Promise<void> {
  const button = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent === 'cookies.save'
  )
  if (!button) throw new Error('save button not rendered')
  await act(async () => {
    button.click()
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
  h.create.mockClear()
  h.update.mockClear()
})

describe('CookieForm — the expiry is shown in local time and stored in UTC', () => {
  it('runs in a UTC-3 zone (precondition)', () => {
    expect(new Date('2026-06-01T00:00:00.000Z').getTimezoneOffset()).toBe(180)
  })

  it('shows the stored UTC expiry as local wall-clock time', async () => {
    await mount(makeCookie({ expires: '2026-06-01T00:00:00.000Z' }))
    expect(expiresInput().value).toBe('2026-05-31T21:00')
  })

  it('saves an edited expiry as the UTC instant of the local time shown', async () => {
    await mount(makeCookie({ expires: '2026-06-01T00:00:00.000Z' }))
    await typeInto(expiresInput(), '2026-06-01T21:00')
    await save()
    expect(h.update).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ expires: '2026-06-02T00:00:00.000Z' })
    )
  })

  it('saves an untouched expiry unchanged, seconds included', async () => {
    await mount(makeCookie({ expires: '2026-06-01T00:00:30.000Z' }))
    expect(expiresInput().value).toBe('2026-05-31T21:00')
    await save()
    expect(h.update).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ expires: '2026-06-01T00:00:30.000Z' })
    )
  })

  it('a cleared expiry is saved as no expiry', async () => {
    await mount(makeCookie({ expires: '2026-06-01T00:00:00.000Z' }))
    await typeInto(expiresInput(), '')
    await save()
    expect(h.update).toHaveBeenCalledWith('c1', expect.objectContaining({ expires: null }))
  })

  it('a new cookie with a typed expiry stores its UTC instant', async () => {
    await mount(null)
    const [name, , domain] = [...document.body.querySelectorAll<HTMLInputElement>('input')]
    await typeInto(name, 'sid')
    await typeInto(domain, 'example.com')
    await typeInto(expiresInput(), '2026-12-31T23:30')
    await save()
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ expires: '2027-01-01T02:30:00.000Z' })
    )
  })
})
