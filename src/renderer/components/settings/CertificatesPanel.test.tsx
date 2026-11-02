/**
 * REQ-0089 — Certificates panel UI.
 *
 * - CA-06/07: the per-row clear-text warning fires only for a workspace cert with
 *   a non-empty literal passphrase (not for a `{{reference}}` nor an empty one).
 * - CA-08: the passphrase input is scope-conditional — a variable-editing text
 *   field on workspace scope, a plain password field on app-global.
 * - CA-04: saving an app-global certificate with a `{{...}}` passphrase is blocked
 *   with a localized error and never reaches the IPC layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClientCertEntry, TlsScope, TlsScopeSettings } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { CertificatesPanel } from './CertificatesPanel'
import { useCertificateStore } from '../../stores/certificates'

const WARNING_LABEL = 'certificates.table.literalPassphraseWarning'

let addClient: ReturnType<typeof vi.fn>

function stubApi(perScope: Record<TlsScope, TlsScopeSettings>): void {
  addClient = vi.fn().mockResolvedValue({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    certificates: {
      list: vi.fn(async (scope: TlsScope) => perScope[scope]),
      addClient,
      updateClient: vi.fn(),
      addCA: vi.fn(),
      updateCA: vi.fn(),
      remove: vi.fn(),
      pickSourceFile: vi.fn()
    }
  }
}

const EMPTY: TlsScopeSettings = { caCertificates: [], clientCertificates: [] }

function client(partial: Partial<ClientCertEntry> & { id: string }): ClientCertEntry {
  return {
    host: 'example.com',
    port: null,
    type: 'pfx',
    pfxFile: 'c.pfx',
    passphrase: null,
    disabled: false,
    ...partial
  }
}

async function mount(scope: TlsScope): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<CertificatesPanel scope={scope} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return { container, root }
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => root.unmount())
  container.remove()
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function clickByText(container: HTMLElement, text: string): void {
  const el = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text)
  )
  if (!el) throw new Error(`No button with text "${text}"`)
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  useCertificateStore.setState({ app: EMPTY, workspace: EMPTY })
})

afterEach(() => {
  vi.restoreAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).api
})

describe('per-row literal-passphrase warning (CA-06/07)', () => {
  it('shows the warning only for a workspace cert with a non-empty literal passphrase', async () => {
    stubApi({
      app: EMPTY,
      workspace: {
        caCertificates: [],
        clientCertificates: [
          client({ id: 'literal', host: 'a.com', passphrase: 'plain-text-pw' }),
          client({ id: 'ref', host: 'b.com', passphrase: '{{cert_pass}}' }),
          client({ id: 'empty', host: 'c.com', passphrase: null })
        ]
      }
    })
    const { container, root } = await mount('workspace')
    const warnings = container.querySelectorAll(`[aria-label="${WARNING_LABEL}"]`)
    expect(warnings).toHaveLength(1)
    unmount(root, container)
  })

  it('never shows the warning on the app-global panel', async () => {
    stubApi({
      app: {
        caCertificates: [],
        clientCertificates: [client({ id: 'literal', host: 'a.com', passphrase: 'plain-text-pw' })]
      },
      workspace: EMPTY
    })
    const { container, root } = await mount('app')
    expect(container.querySelectorAll(`[aria-label="${WARNING_LABEL}"]`)).toHaveLength(0)
    unmount(root, container)
  })
})

describe('scope-conditional passphrase input (CA-08)', () => {
  async function passphraseTypeFor(
    scope: TlsScope,
    text?: string
  ): Promise<string | null | undefined> {
    stubApi({ app: EMPTY, workspace: EMPTY })
    const { container, root } = await mount(scope)
    clickByText(container, 'certificates.actions.addClient')
    await act(async () => {
      await Promise.resolve()
    })
    if (text !== undefined) {
      const initial = document.body.querySelector<HTMLInputElement>(
        'input[placeholder="certificates.form.client.passphrasePlaceholder"]'
      )!
      setInputValue(initial, text)
      await act(async () => {
        await Promise.resolve()
      })
    }
    // The secret field is a password input while masking a literal and a text
    // input once the value is a visible {{variable}} reference.
    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="certificates.form.client.passphrasePlaceholder"]'
    )
    const type = input?.getAttribute('type')
    unmount(root, container)
    return type
  }

  it('masks an app-global passphrase as a password field', async () => {
    expect(await passphraseTypeFor('app', 'literal-value')).toBe('password')
  })

  it('masks an empty workspace passphrase by default', async () => {
    expect(await passphraseTypeFor('workspace')).toBe('password')
  })

  it('masks a literal workspace passphrase as a password field', async () => {
    expect(await passphraseTypeFor('workspace', 'my-literal-pass')).toBe('password')
  })

  it('reveals a workspace passphrase once it is written as a {{variable}}', async () => {
    // Variable-editing field is a text input (the mirror overlay highlights tokens).
    expect(await passphraseTypeFor('workspace', '{{cert_pass}}')).not.toBe('password')
  })
})

describe('app-global save rejection (CA-04)', () => {
  it('blocks saving a {{variable}} passphrase and never calls the IPC', async () => {
    stubApi({ app: EMPTY, workspace: EMPTY })
    const { container, root } = await mount('app')
    clickByText(container, 'certificates.actions.addClient')
    await act(async () => {
      await Promise.resolve()
    })

    const hostInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="certificates.form.client.hostPlaceholder"]'
    )!
    const passInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="certificates.form.client.passphrasePlaceholder"]'
    )!
    setInputValue(hostInput, 'api.example.com')
    setInputValue(passInput, '{{cert_pass}}')

    clickByText(document.body, 'certificates.actions.import')
    await act(async () => {
      await Promise.resolve()
    })

    expect(addClient).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('certificates.errors.passphraseVariableNotAllowed')

    unmount(root, container)
  })
})
