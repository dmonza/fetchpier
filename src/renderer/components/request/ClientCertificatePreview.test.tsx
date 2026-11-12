import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClientCertPreview } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key) => key })
}))

import { ClientCertificatePreview } from './ClientCertificatePreview'
import { useEnvironmentStore } from '../../stores/environment'

let root: Root | null = null
let container: HTMLDivElement | null = null
let previewForRequest: ReturnType<
  typeof vi.fn<(args: { url: string }) => Promise<ClientCertPreview>>
>

const SELECTED: ClientCertPreview = {
  selected: {
    id: 'cc-api',
    host: 'api.example.com',
    port: null,
    type: 'pfx',
    pfxFile: 'client-api.pfx',
    passphrase: null,
    disabled: false
  },
  scope: 'workspace'
}

beforeEach(() => {
  vi.useFakeTimers()
  previewForRequest = vi.fn(async () => SELECTED)
  vi.stubGlobal('window', {
    ...window,
    api: { certificates: { previewForRequest, onChanged: () => () => {} } }
  })
  useEnvironmentStore.setState({ activeEnvironmentId: 'env-dev', environments: [] })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(url: string): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ClientCertificatePreview url={url} />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  return container
}

// TLS-03 — the preview hands the URL as the editor holds it to main, which
// resolves its variables; it is not short-circuited to "none" here.
describe('ClientCertificatePreview', () => {
  it('asks main about a URL built from variables and shows the certificate it names', async () => {
    const el = await render('{{baseUrl}}/users')
    expect(previewForRequest).toHaveBeenCalledWith({ url: '{{baseUrl}}/users' })
    expect(el.textContent).toContain('client-api.pfx')
    expect(el.textContent).not.toContain('certificates.preview.none')
  })

  it('says the certificate cannot be determined when main reports an unresolved host', async () => {
    previewForRequest.mockResolvedValue({ selected: null, scope: null, undetermined: true })
    const el = await render('{{nope}}/users')
    expect(el.textContent).toContain('certificates.preview.undetermined')
    expect(el.textContent).not.toContain('certificates.preview.none')
  })

  it('shows none without asking main for an empty URL', async () => {
    const el = await render('')
    expect(previewForRequest).not.toHaveBeenCalled()
    expect(el.textContent).toContain('certificates.preview.none')
  })

  it('asks again when the active environment changes', async () => {
    await render('{{baseUrl}}/users')
    expect(previewForRequest).toHaveBeenCalledTimes(1)
    act(() => useEnvironmentStore.setState({ activeEnvironmentId: 'env-prod' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(previewForRequest).toHaveBeenCalledTimes(2)
  })
})
