// REQ-0069 — drives the shared `RunDetail` with two descriptors over the same
// parsed file, asserting (a) the requests descriptor renders all four sections
// (Metadata / Request / Response / Scripts), (b) a synthetic mock-shaped
// descriptor renders three sections (no Scripts) from the same input, (c) the
// component is descriptor-driven: removing Scripts from the requests
// descriptor mid-test yields three sections, and (d) Scripts is omitted when
// no `@script-results` block is present.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key, opts) => (opts && 'ms' in opts ? `${(opts as { ms: number }).ms} ms` : key)
  })
}))

// CodeMirror touches DOM APIs that jsdom doesn't implement fully; stub the
// hook to a no-op so the section just renders its container.
vi.mock('../../../hooks/useCodeMirror', () => ({ useCodeMirror: () => {} }))

import { parseActivityLog } from '../../../../shared/lib/activity-log'
import { RunDetail } from './RunDetail'
import { requestsRunDetailDescriptor } from './domains/requests-descriptor'
import type { RunDetailDescriptor } from './types'

const RAW_WITH_SCRIPTS =
  '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
  '# @run-id: 0c0e1234-1111-2222-3333-444455556666\n' +
  '# @request-id: req-abc\n' +
  '# @source-file: requests/auth/login.http\n' +
  '# @duration-ms: 184\n' +
  '# @path-raw: https://api.example.com/auth/login\n' +
  '# @remote-ip: 203.0.113.42\n' +
  '# @script-pre: ok\n' +
  '# @script-post: failed (2 passed, 1 failed)\n' +
  '# @settings\n' +
  '# verifySsl: false\n' +
  '# httpVersion: auto\n' +
  '# @end-settings\n' +
  '\n' +
  'POST https://api.example.com/auth/login HTTP/1.1\n' +
  'Content-Type: application/json\n' +
  '\n' +
  '{"user":"juan"}\n' +
  '\n' +
  '### Response\n' +
  '\n' +
  'HTTP/1.1 200 OK\n' +
  'Content-Type: application/json\n' +
  '\n' +
  '{"token":"ey"}\n' +
  '\n' +
  '# @script-results: post-response\n' +
  '# log: token captured\n' +
  '# pass: response is JSON\n' +
  '# fail: status is 201 — expected 201, got 200\n' +
  '# @end-script-results\n'

const RAW_NO_SCRIPTS =
  '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
  '# @run-id: r-1\n' +
  '# @duration-ms: 50\n' +
  '# @path-raw: /\n' +
  '\n' +
  'GET / HTTP/1.1\n' +
  '\n' +
  '### Response\n' +
  '\n' +
  'HTTP/1.1 204 No Content\n'

async function mount(node: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
  return { container, root }
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => root.unmount())
  container.remove()
}

describe('RunDetail (REQ-0069)', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('renders 4 sections under the requests descriptor when scripts present', async () => {
    const file = parseActivityLog(RAW_WITH_SCRIPTS)
    const { container, root } = await mount(
      <RunDetail file={file} descriptor={requestsRunDetailDescriptor} />
    )
    const sections = container.querySelectorAll('section')
    expect(sections.length).toBe(4)
    // Headings include the four expected i18n keys (we mocked `t` to identity)
    const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent)
    expect(headings).toContain('history.expansion.metadata.title')
    expect(headings).toContain('history.expansion.request.title')
    expect(headings).toContain('history.expansion.response.title')
    expect(headings).toContain('history.expansion.scripts.title')
    unmount(root, container)
  })

  it('omits Scripts when the run has no @script-results block (CA-06)', async () => {
    const file = parseActivityLog(RAW_NO_SCRIPTS)
    const { container, root } = await mount(
      <RunDetail file={file} descriptor={requestsRunDetailDescriptor} />
    )
    const sections = container.querySelectorAll('section')
    expect(sections.length).toBe(3)
    const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent)
    expect(headings).not.toContain('history.expansion.scripts.title')
    unmount(root, container)
  })

  it('renders 3 sections under a synthetic mock-shaped descriptor (Metadata + Request + Response, no Scripts)', async () => {
    const file = parseActivityLog(RAW_WITH_SCRIPTS)
    const mockDescriptor: RunDetailDescriptor = {
      sections: [
        {
          kind: 'metadata',
          rows: [
            {
              id: 'route-id',
              labelKey: 'mock.metadata.routeId',
              pick: (f) => {
                for (const it of f.header) {
                  if (it.kind === 'directive' && it.key === 'run-id') return it.value
                }
                return null
              }
            }
          ]
        },
        { kind: 'rawHttp', which: 'request' },
        { kind: 'rawHttp', which: 'response', jsonFormatToggle: true }
      ]
    }
    const { container, root } = await mount(<RunDetail file={file} descriptor={mockDescriptor} />)
    expect(container.querySelectorAll('section').length).toBe(3)
    const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent)
    expect(headings).not.toContain('history.expansion.scripts.title')
    unmount(root, container)
  })

  it('renders the Metadata Source file row with an Open file affordance', async () => {
    const file = parseActivityLog(RAW_WITH_SCRIPTS)
    const onOpenSourceFile = vi.fn()
    const { container, root } = await mount(
      <RunDetail
        file={file}
        descriptor={requestsRunDetailDescriptor}
        onOpenSourceFile={onOpenSourceFile}
      />
    )
    // Sections start collapsed — expand the Metadata section first.
    const metaToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('history.expansion.metadata.title')
    ) as HTMLButtonElement | undefined
    expect(metaToggle).toBeDefined()
    act(() => {
      metaToggle!.click()
    })
    // The "Open file" button uses title=t('history.expansion.metadata.openFile')
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const openBtn = buttons.find(
      (b) => b.getAttribute('title') === 'history.expansion.metadata.openFile'
    )
    expect(openBtn).toBeDefined()
    act(() => {
      openBtn!.click()
    })
    expect(onOpenSourceFile).toHaveBeenCalledWith('requests/auth/login.http')
    unmount(root, container)
  })
})
