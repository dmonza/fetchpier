import { describe, it, expect } from 'vitest'
import { defaultReqTabForMethod } from './req-tab'

describe('defaultReqTabForMethod', () => {
  it('opens payload-carrying methods on the Body tab', () => {
    expect(defaultReqTabForMethod('POST')).toBe('body')
    expect(defaultReqTabForMethod('PUT')).toBe('body')
    expect(defaultReqTabForMethod('PATCH')).toBe('body')
  })

  it('opens the rest on the Params tab', () => {
    expect(defaultReqTabForMethod('GET')).toBe('params')
    expect(defaultReqTabForMethod('DELETE')).toBe('params')
    expect(defaultReqTabForMethod('HEAD')).toBe('params')
    expect(defaultReqTabForMethod('OPTIONS')).toBe('params')
  })

  it('is case-insensitive', () => {
    expect(defaultReqTabForMethod('post')).toBe('body')
    expect(defaultReqTabForMethod('get')).toBe('params')
  })
})
