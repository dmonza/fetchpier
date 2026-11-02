import { describe, it, expect } from 'vitest'
import { serializeRequest } from '@shared/lib/http-serializer'
import { hashString } from '@shared/lib/hash'
import { DEFAULT_REQUEST_STATE } from '../../shared/types'
import type { Tab, RequestEditorState } from '../../shared/types'
import { computeTabDirty, cleanHashOf } from './tab-dirty'

function makeTab(overrides: Partial<Tab> = {}): Tab {
  const request = overrides.request ?? { ...DEFAULT_REQUEST_STATE }
  return {
    id: '1',
    title: 'Untitled',
    filePath: null,
    isDirty: false,
    request,
    response: null,
    isLoading: false,
    error: null,
    requestId: 'req-1',
    mode: 'permanent',
    ...overrides
  }
}

describe('computeTabDirty', () => {
  it('is false when no baseline has been captured (cleanHash undefined)', () => {
    const tab = makeTab({ request: { ...DEFAULT_REQUEST_STATE, url: 'https://x' } })
    expect(tab.cleanHash).toBeUndefined()
    expect(computeTabDirty(tab)).toBe(false)
  })

  it('is false when current content matches the baseline', () => {
    const tab = makeTab()
    const clean = makeTab({ cleanHash: cleanHashOf(tab) })
    expect(computeTabDirty(clean)).toBe(false)
  })

  it('is true when current content diverges from the baseline', () => {
    const base = makeTab()
    const cleanHash = cleanHashOf(base)
    const edited = makeTab({
      cleanHash,
      request: { ...DEFAULT_REQUEST_STATE, url: 'https://changed' }
    })
    expect(computeTabDirty(edited)).toBe(true)
  })

  it('is true when a malformed param exists even if the serialized content matches the baseline', () => {
    const request: RequestEditorState = {
      ...DEFAULT_REQUEST_STATE,
      params: [{ id: 'p1', key: 'a', value: '%', enabled: true, malformed: true }]
    }
    // The serializer drops malformed params, so the baseline equals the current
    // serialized content; only the malformed term makes it dirty.
    const tab = makeTab({ request, cleanHash: hashString(serializeRequest(request, 'req-1')) })
    expect(computeTabDirty(tab)).toBe(true)
  })

  it('is true when the load normalized away stray content (CA-13)', () => {
    const tab = makeTab({ cleanHash: cleanHashOf(makeTab()), normalizedOnLoad: true })
    expect(computeTabDirty(tab)).toBe(true)
  })

  it('is true when a multipart part carries a parse error (CA-11)', () => {
    const request: RequestEditorState = {
      ...DEFAULT_REQUEST_STATE,
      bodyType: 'multipart-form',
      multipartParts: [
        {
          kind: 'file',
          id: 'p0',
          name: 'broken',
          file: {
            ref: 'bad',
            originalName: 'x',
            sizeBytes: 0,
            mimeType: 'application/octet-stream'
          },
          disabled: true,
          parseError: 'unreadable'
        }
      ]
    }
    const tab = makeTab({ request, cleanHash: hashString(serializeRequest(request, 'req-1')) })
    expect(computeTabDirty(tab)).toBe(true)
  })

  it('is false for read-only / history tabs', () => {
    const tab = makeTab({
      isReadOnly: true,
      cleanHash: undefined,
      request: { ...DEFAULT_REQUEST_STATE, url: 'https://x' }
    })
    expect(computeTabDirty(tab)).toBe(false)
  })
})

// ── Value-less query parameters (REQ-0124) ──────────────────────────────────
// A value-less param is a valid, fully-understood parameter — deliberately NOT a
// degradation like a malformed one, so it must not mark the tab modified.

describe('computeTabDirty — value-less query params (REQ-0124)', () => {
  const flagged: RequestEditorState = {
    ...DEFAULT_REQUEST_STATE,
    url: 'https://svc/orders.aspx',
    params: [{ id: 'p1', key: 'wsdl', value: '', enabled: true, valueless: true }]
  }

  it('is false for a request loaded with a value-less param', () => {
    const tab = makeTab({ request: flagged })
    expect(computeTabDirty(makeTab({ request: flagged, cleanHash: cleanHashOf(tab) }))).toBe(false)
  })

  it('is true once the value cell is edited, because the serialized text changes', () => {
    const baseline = cleanHashOf(makeTab({ request: flagged }))
    const edited: RequestEditorState = {
      ...flagged,
      params: [{ id: 'p1', key: 'wsdl', value: '', enabled: true, valueless: false }]
    }
    expect(serializeRequest(edited)).not.toBe(serializeRequest(flagged))
    expect(computeTabDirty(makeTab({ request: edited, cleanHash: baseline }))).toBe(true)
  })
})
