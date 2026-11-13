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
let updateClient: ReturnType<typeof vi.fn>
let addCA: ReturnType<typeof vi.fn>
let removeCert: ReturnType<typeof vi.fn>
let pickSourceFile: ReturnType<typeof vi.fn>

function stubApi(perScope: Record<TlsScope, TlsScopeSettings>): void {
  addClient = vi.fn().mockResolvedValue({})
  updateClient = vi.fn().mockResolvedValue({})
  addCA = vi.fn().mockResolvedValue({})
  removeCert = vi.fn().mockResolvedValue({ removed: true })
  pickSourceFile = vi.fn().mockResolvedValue('/picked/file.pfx')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    certificates: {
      list: vi.fn(async (scope: TlsScope) => perScope[scope]),
      addClient,
      updateClient,
      addCA,
      updateCA: vi.fn(),
      remove: removeCert,
      pickSourceFile
    }
  }
}

const WORKSPACE_PASS = 'input[placeholder="certificates.form.client.passphrasePlaceholder"]'
const APP_PASS = 'input[placeholder="certificates.form.client.passphrasePlaceholderLiteral"]'
const passSelector = (scope: TlsScope): string => (scope === 'app' ? APP_PASS : WORKSPACE_PASS)

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
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
      const initial = document.body.querySelector<HTMLInputElement>(passSelector(scope))!
      setInputValue(initial, text)
      await act(async () => {
        await Promise.resolve()
      })
    }
    // The secret field is a password input while masking a literal and a text
    // input once the value is a visible {{variable}} reference.
    const input = document.body.querySelector<HTMLInputElement>(passSelector(scope))
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
    const passInput = document.body.querySelector<HTMLInputElement>(APP_PASS)!
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

// TLS-13 — the hint offers only what the scope's save accepts.
describe('scope-specific passphrase placeholder', () => {
  it.each([
    ['app', APP_PASS, WORKSPACE_PASS],
    ['workspace', WORKSPACE_PASS, APP_PASS]
  ] as const)('the %s add dialog offers its own hint', async (scope, shown, hidden) => {
    stubApi({ app: EMPTY, workspace: EMPTY })
    const { container, root } = await mount(scope)
    clickByText(container, 'certificates.actions.addClient')
    await flush()
    expect(document.body.querySelector(shown)).not.toBeNull()
    expect(document.body.querySelector(hidden)).toBeNull()
    unmount(root, container)
  })

  it('the app-global edit dialog offers the literal-only hint', async () => {
    stubApi({
      app: { caCertificates: [], clientCertificates: [client({ id: 'c1', host: 'a.com' })] },
      workspace: EMPTY
    })
    const { container, root } = await mount('app')
    clickByText(container, 'certificates.actions.edit')
    await flush()
    expect(document.body.querySelector(APP_PASS)).not.toBeNull()
    expect(document.body.querySelector(WORKSPACE_PASS)).toBeNull()
    unmount(root, container)
  })
})

const HOST_INPUT = 'input[placeholder="certificates.form.client.hostPlaceholder"]'
const PORT_INPUT = 'input[placeholder="certificates.form.client.portPlaceholder"]'

/** Opens the add dialog (PFX type is not selectable here, so PEM: pick both files). */
async function openAddClient(scope: TlsScope): Promise<{ container: HTMLDivElement; root: Root }> {
  const mounted = await mount(scope)
  clickByText(mounted.container, 'certificates.actions.addClient')
  await flush()
  for (const b of Array.from(document.body.querySelectorAll('button')).filter((b) =>
    b.textContent?.includes('certificates.form.client.pickFile')
  )) {
    act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
  }
  setInputValue(document.body.querySelector<HTMLInputElement>(HOST_INPUT)!, 'api.example.com')
  return mounted
}

// TLS-10 — ports follow the CLI's rule (integer 1–65535), with a translated message.
describe('client certificate port validation', () => {
  it.each(['abc', '0', '65536', '70000', '443.5', '1e3', '0x1bb', '-1'])(
    'the add dialog rejects port %j with the translated message',
    async (port) => {
      stubApi({ app: EMPTY, workspace: EMPTY })
      const { container, root } = await openAddClient('workspace')
      setInputValue(document.body.querySelector<HTMLInputElement>(PORT_INPUT)!, port)
      clickByText(document.body, 'certificates.actions.import')
      await flush()
      expect(addClient).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('certificates.errors.invalidPort')
      expect(document.body.textContent).not.toContain('Invalid port')
      unmount(root, container)
    }
  )

  it.each([
    ['1', 1],
    ['65535', 65535],
    [' 8443 ', 8443],
    ['', null]
  ])('the add dialog accepts port %j', async (port, expected) => {
    stubApi({ app: EMPTY, workspace: EMPTY })
    const { container, root } = await openAddClient('workspace')
    setInputValue(document.body.querySelector<HTMLInputElement>(PORT_INPUT)!, port)
    clickByText(document.body, 'certificates.actions.import')
    await flush()
    expect(addClient).toHaveBeenCalledWith(expect.objectContaining({ port: expected }))
    unmount(root, container)
  })

  it('the edit dialog rejects an out-of-range port with the translated message', async () => {
    stubApi({
      app: EMPTY,
      workspace: { caCertificates: [], clientCertificates: [client({ id: 'c1', port: 443 })] }
    })
    const { container, root } = await mount('workspace')
    clickByText(container, 'certificates.actions.edit')
    await flush()
    setInputValue(document.body.querySelector<HTMLInputElement>(PORT_INPUT)!, '70000')
    clickByText(document.body, 'certificates.actions.save')
    await flush()
    expect(updateClient).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('certificates.errors.invalidPort')
    unmount(root, container)
  })
})

// TLS-12 — a refusal from main is shown translated, never as Electron's text.
describe('certificate import and edit errors', () => {
  const remote = (channel: string, inner: string): Error =>
    new Error(`Error invoking remote method '${channel}': ${inner}`)

  it('the CA import dialog translates a non-PEM file', async () => {
    stubApi({ app: EMPTY, workspace: EMPTY })
    addCA.mockRejectedValue(
      remote(
        'certificates:addCA',
        'TlsImportError: TLS_CERT_NOT_PEM: No PEM CERTIFICATE block found in file'
      )
    )
    const { container, root } = await mount('app')
    clickByText(container, 'certificates.actions.addCA')
    await flush()
    clickByText(document.body, 'certificates.form.client.pickFile')
    await flush()
    clickByText(document.body, 'certificates.actions.import')
    await flush()
    expect(document.body.textContent).toContain('certificates.errors.certNotPem')
    expect(document.body.textContent).not.toContain('invoking remote method')
    expect(document.body.textContent).not.toContain('TlsImportError')
    unmount(root, container)
  })

  it('the client add dialog translates an invalid host pattern', async () => {
    stubApi({ app: EMPTY, workspace: EMPTY })
    addClient.mockRejectedValue(
      remote('certificates:addClient', 'TlsImportError: TLS_HOST_INVALID: Host pattern must be…')
    )
    const { container, root } = await openAddClient('workspace')
    clickByText(document.body, 'certificates.actions.import')
    await flush()
    expect(document.body.textContent).toContain('certificates.errors.invalidHost')
    expect(document.body.textContent).not.toContain('invoking remote method')
    unmount(root, container)
  })

  it('the edit dialog falls back to the save message without the Electron prefix', async () => {
    stubApi({
      app: EMPTY,
      workspace: { caCertificates: [], clientCertificates: [client({ id: 'c1' })] }
    })
    updateClient.mockRejectedValue(
      remote('certificates:updateClient', 'Error: EACCES: permission denied')
    )
    const { container, root } = await mount('workspace')
    clickByText(container, 'certificates.actions.edit')
    await flush()
    clickByText(document.body, 'certificates.actions.save')
    await flush()
    expect(document.body.textContent).toContain(
      'certificates.errors.saveFailed:{"message":"EACCES: permission denied"}'
    )
    expect(document.body.textContent).not.toContain('invoking remote method')
    unmount(root, container)
  })
})

// TLS-11 — a remove or toggle that main refused is reported in the panel.
describe('row actions that fail', () => {
  const failure = new Error(
    "Error invoking remote method 'certificates:remove': Error: EACCES: permission denied"
  )

  it.each(['ca', 'client'] as const)(
    'a refused %s removal shows the translated error',
    async (kind) => {
      stubApi({
        app: EMPTY,
        workspace: {
          caCertificates: kind === 'ca' ? [{ id: 'ca-1', file: 'ca.pem' }] : [],
          clientCertificates: kind === 'client' ? [client({ id: 'c1' })] : []
        }
      })
      removeCert.mockRejectedValue(failure)
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { container, root } = await mount('workspace')
      clickByText(container, 'certificates.actions.remove')
      await flush()
      expect(removeCert).toHaveBeenCalled()
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'certificates.errors.removeFailed:{"message":"EACCES: permission denied"}'
      )
      unmount(root, container)
    }
  )

  it('a refused enable toggle shows the translated error, cleared by the next success', async () => {
    stubApi({
      app: EMPTY,
      workspace: { caCertificates: [], clientCertificates: [client({ id: 'c1' })] }
    })
    updateClient.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    const { container, root } = await mount('workspace')
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'certificates.errors.toggleFailed:{"message":"EACCES: permission denied"}'
    )

    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(updateClient).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    unmount(root, container)
  })
})
