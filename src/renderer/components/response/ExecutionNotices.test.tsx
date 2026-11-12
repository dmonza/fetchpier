/**
 * CLI readiness — the desktop surfaces for the send advisories that used to be
 * console-only (CA-31): the decoding status next to the size, and a dismissible
 * notice for cookie-jar / TLS / downgrade / unsaved-write advisories.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExecutionWarning, HttpResponse } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

vi.mock('../../hooks/useCodeMirror', () => ({ useCodeMirror: () => ({}) }))

import { ExecutionNotices, noticeWarningsOf } from './ExecutionNotices'
import { ResponseSize } from './ResponseViewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

const response = (over: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  statusText: 'OK',
  headers: {},
  body: '',
  timingMs: 1,
  sizeBytes: 2048,
  ...over
})

describe('noticeWarningsOf', () => {
  it('keeps only the families the notice owns', () => {
    const warnings: ExecutionWarning[] = [
      { code: 'UNRESOLVED_VARIABLE', name: 'token' },
      { code: 'COOKIE_JAR_UNAVAILABLE', phase: 'read', reason: 'EACCES' },
      { code: 'COOKIE_REJECTED', name: 'sid', host: 'a.test', reason: 'PUBLIC_SUFFIX' },
      { code: 'TLS_MATERIAL_UNAVAILABLE', reason: 'unreadable cert' },
      { code: 'UNSUPPORTED_CONTENT_ENCODING', encoding: 'zstd' },
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'KEY_MISSING' }
    ]
    expect(noticeWarningsOf(warnings).map((w) => w.code)).toEqual([
      'COOKIE_JAR_UNAVAILABLE',
      'TLS_MATERIAL_UNAVAILABLE',
      'ENV_WRITE_NOT_PERSISTED'
    ])
  })
})

describe('ExecutionNotices', () => {
  it('renders nothing when there is nothing to tell', () => {
    const el = render(<ExecutionNotices warnings={[{ code: 'UNRESOLVED_VARIABLE', name: 'x' }]} />)
    expect(el.textContent).toBe('')
  })

  it('explains a cookie jar that could not be read, and can be dismissed', () => {
    const warnings: ExecutionWarning[] = [
      { code: 'COOKIE_JAR_UNAVAILABLE', phase: 'read', reason: 'EACCES' }
    ]
    const el = render(<ExecutionNotices warnings={warnings} />)
    expect(el.textContent).toContain('response.notices.cookieJarRead')
    expect(el.textContent).toContain('EACCES')
    act(() => (el.querySelector('button') as HTMLButtonElement).click())
    expect(el.textContent).toBe('')
  })

  it('names the variable of an unsaved script write, never a value', () => {
    const el = render(
      <ExecutionNotices
        warnings={[
          { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'LOCAL_KEY_MISMATCH' }
        ]}
      />
    )
    expect(el.textContent).toContain('response.notices.envWriteKeyMismatch:{"name":"token"}')
  })

  it('explains a script write whose save failed, one line per name', () => {
    const el = render(
      <ExecutionNotices
        warnings={[
          { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'WRITE_FAILED' },
          { code: 'ENV_WRITE_NOT_PERSISTED', name: 'old', reason: 'WRITE_FAILED' }
        ]}
      />
    )
    expect(el.querySelectorAll('li')).toHaveLength(2)
    expect(el.textContent).toContain('response.notices.envWriteFailed:{"name":"token"}')
    expect(el.textContent).toContain('response.notices.envWriteFailed:{"name":"old"}')
    expect(el.textContent).not.toContain('envWriteKeyMismatch')
  })
})

describe('ResponseSize', () => {
  it('shows both sizes for a decoded response', () => {
    const el = render(
      <ResponseSize
        response={response({
          decodingStatus: 'decoded',
          compressedBytes: 512,
          decompressedBytes: 4096
        })}
      />
    )
    expect(el.textContent).toBe(
      'response.size.decoded:{"compressed":"512 B","decompressed":"4.0 KB"}'
    )
  })

  it('shows the decoding problem next to the size for an unsupported coding', () => {
    const el = render(
      <ResponseSize
        response={response({
          decodingStatus: 'unsupported',
          headers: { 'Content-Encoding': 'zstd' }
        })}
      />
    )
    expect(el.textContent).toContain('2.0 KB')
    expect(el.textContent).toContain('response.size.unsupported:{"encoding":"zstd"}')
  })

  it('shows only the size for an uncompressed or history-rebuilt response', () => {
    expect(render(<ResponseSize response={response()} />).textContent).toBe('2.0 KB')
  })
})
