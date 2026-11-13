import { describe, expect, it } from 'vitest'
import { METHOD_TOKEN } from './method-token'

describe('METHOD_TOKEN', () => {
  it.each(['GET', 'propfind', 'VERSION-CONTROL', 'M2', 'X'])('accepts %s', (method) => {
    expect(METHOD_TOKEN.test(method)).toBe(true)
  })

  it.each(['', '2M', '-GET', 'GE_T', 'GET /x'])('rejects %j', (method) => {
    expect(METHOD_TOKEN.test(method)).toBe(false)
  })
})
