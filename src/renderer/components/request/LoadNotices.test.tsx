import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RequestEditorState } from '../../../shared/types'
import { DEFAULT_REQUEST_STATE } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key, opts) => (opts ? `${key} ${JSON.stringify(opts)}` : key)
  })
}))

import { LoadNotices } from './LoadNotices'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(props: Parameters<typeof LoadNotices>[0]): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<LoadNotices {...props} />))
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

const binary = (overrides: Partial<RequestEditorState> = {}): RequestEditorState => ({
  ...DEFAULT_REQUEST_STATE,
  method: 'POST',
  bodyType: 'binary',
  ...overrides
})

describe('LoadNotices', () => {
  it('lists the load warnings under a localized heading', () => {
    const el = render({
      request: DEFAULT_REQUEST_STATE,
      loadWarnings: ['invalid # @auth block: unknown type "digest"', 'unknown # @settings key "x"']
    })
    const notice = el.querySelector('[data-notice="load-warnings"]')!
    expect(notice.textContent).toContain('request.loadWarnings.title')
    expect(notice.textContent).toContain('request.loadWarnings.detail')
    expect(Array.from(notice.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      'invalid # @auth block: unknown type "digest"',
      'unknown # @settings key "x"'
    ])
  })

  it('advises re-attaching a file whose reference is not valid, naming it', () => {
    const el = render({ request: binary({ invalidBinaryRef: 'not-a-ref' }) })
    const notice = el.querySelector('[data-notice="invalid-binary-ref"]')!
    expect(notice.textContent).toContain('request.invalidBinaryRef.title')
    expect(notice.textContent).toContain('"ref":"not-a-ref"')
    expect(el.querySelector('[data-notice="load-warnings"]')).toBeNull()
  })

  it('drops the advisory once a valid file is attached, or the body leaves binary mode', () => {
    const file = {
      ref: `${'a'.repeat(64)}__a.bin`,
      originalName: 'a.bin',
      sizeBytes: 1,
      mimeType: 'application/octet-stream'
    }
    expect(
      render({
        request: binary({ invalidBinaryRef: 'not-a-ref', binaryFile: file })
      }).querySelector('[data-notice]')
    ).toBeNull()
    act(() => root!.unmount())
    container!.remove()
    expect(
      render({
        request: binary({ invalidBinaryRef: 'not-a-ref', bodyType: 'raw' })
      }).querySelector('[data-notice]')
    ).toBeNull()
  })

  it('renders nothing for a file that loaded cleanly', () => {
    const el = render({ request: DEFAULT_REQUEST_STATE, loadWarnings: undefined })
    expect(el.childElementCount).toBe(0)
  })

  it('renders nothing for an empty warnings list', () => {
    expect(render({ request: DEFAULT_REQUEST_STATE, loadWarnings: [] }).childElementCount).toBe(0)
  })
})
