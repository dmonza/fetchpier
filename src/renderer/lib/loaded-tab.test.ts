import { describe, it, expect } from 'vitest'
import type { HttpRequest, ParsedHttpFile } from '../../shared/types'
import { loadedTabFields } from './loaded-tab'

const request = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET',
  url: 'https://x/users?page=2',
  headers: {},
  ...overrides
})

const file = (overrides: Partial<ParsedHttpFile> = {}): ParsedHttpFile => ({
  requests: [request()],
  variablesUsed: [],
  ...overrides
})

describe('loadedTabFields', () => {
  it('maps the first request into the editor state, with the tab fields a load sets', () => {
    const fields = loadedTabFields(
      file({ requestId: 'file-id', tail: '\n###\nGET https://y/\n' }),
      'tab-id'
    )
    expect(fields?.request.url).toBe('https://x/users')
    expect(fields?.request.params.map((p) => [p.key, p.value])).toEqual([['page', '2']])
    expect(fields?.requestId).toBe('file-id')
    expect(fields?.tail).toBe('\n###\nGET https://y/\n')
  })

  it("keeps the tab's own id when the file has none", () => {
    expect(loadedTabFields(file(), 'tab-id')?.requestId).toBe('tab-id')
  })

  it("carries the first request's load warnings and normalization mark", () => {
    const fields = loadedTabFields(
      file({
        requests: [
          request({ loadWarnings: ['unknown # @settings key "x"'], normalizedOnLoad: true }),
          request({ loadWarnings: ['from the second request'] })
        ],
        warnings: ['unknown # @settings key "x"', 'from the second request']
      }),
      'tab-id'
    )
    expect(fields?.loadWarnings).toEqual(['unknown # @settings key "x"'])
    expect(fields?.normalizedOnLoad).toBe(true)
  })

  it('carries neither for a clean file', () => {
    const fields = loadedTabFields(file(), 'tab-id')
    expect(fields?.loadWarnings).toBeUndefined()
    expect(fields?.normalizedOnLoad).toBeUndefined()
  })

  it('yields nothing for a file with no request', () => {
    expect(loadedTabFields(file({ requests: [] }), 'tab-id')).toBeNull()
  })
})
