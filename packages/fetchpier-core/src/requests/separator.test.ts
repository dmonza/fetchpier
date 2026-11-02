import { describe, it, expect } from 'vitest'
import { isRequestLine, findRequestSeparators } from './separator'

describe('isRequestLine', () => {
  it('accepts a method + scheme-prefixed URL', () => {
    expect(isRequestLine('GET https://api.example.com/users')).toBe(true)
    expect(isRequestLine('POST http://localhost:3000/x')).toBe(true)
  })

  it('accepts a leading-slash path, a {{token}} URL, and a host-with-a-dot', () => {
    expect(isRequestLine('GET /api/users')).toBe(true)
    expect(isRequestLine('POST {{baseUrl}}/login HTTP/1.1')).toBe(true)
    expect(isRequestLine('DELETE api.example.com/items/1')).toBe(true)
    expect(isRequestLine('GET localhost:8080/health')).toBe(true)
  })

  it('rejects prose, headings, and single tokens (bias to not split)', () => {
    expect(isRequestLine('This is a heading')).toBe(false)
    expect(isRequestLine('### Section')).toBe(false)
    expect(isRequestLine('GET')).toBe(false)
    expect(isRequestLine('Some notes about the API')).toBe(false)
    expect(isRequestLine('- item one two')).toBe(false)
  })
})

describe('findRequestSeparators', () => {
  it('treats a ### line as a separator only when a request line follows', () => {
    const lines = ['GET https://a/1', '', '### second', 'GET https://a/2', '']
    expect(findRequestSeparators(lines)).toEqual([2])
  })

  it('does not split on a ### line inside a body (no request line follows)', () => {
    const lines = [
      'POST https://a/1',
      'Content-Type: text/markdown',
      '',
      '### Heading in markdown body',
      'Some prose, not a request.'
    ]
    expect(findRequestSeparators(lines)).toEqual([])
  })

  it('skips blank and comment lines after the ### before deciding', () => {
    const lines = [
      'GET https://a/1',
      '',
      '###',
      '',
      '# @id 9e3a4f72-1234-4abc-9def-0123456789ab',
      'GET https://a/2'
    ]
    expect(findRequestSeparators(lines)).toEqual([2])
  })

  it('finds multiple separators in a three-request file', () => {
    const lines = ['GET https://a/1', '### b', 'GET https://a/2', '### c', 'GET https://a/3']
    expect(findRequestSeparators(lines)).toEqual([1, 3])
  })
})
