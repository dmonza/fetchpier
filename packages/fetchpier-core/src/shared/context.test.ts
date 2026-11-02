import { describe, expect, it } from 'vitest'
import { CoreError, type CoreErrorCode } from './context'

describe('CoreError', () => {
  it('carries code, message and details', () => {
    const details = { path: '/tmp/ws' }
    const err = new CoreError('WORKSPACE_NOT_FOUND', 'no workspace', details)
    expect(err.code).toBe('WORKSPACE_NOT_FOUND')
    expect(err.message).toBe('no workspace')
    expect(err.details).toBe(details)
  })

  it('is an instance of Error and CoreError', () => {
    const err = new CoreError('INTERNAL_ERROR', 'boom')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CoreError)
    expect(err.name).toBe('CoreError')
  })

  it('leaves details undefined when omitted', () => {
    const err = new CoreError('PARSE_ERROR', 'bad input')
    expect(err.details).toBeUndefined()
  })

  it('accepts every documented code', () => {
    const codes: CoreErrorCode[] = [
      'WORKSPACE_NOT_FOUND',
      'WORKSPACE_INVALID',
      'ENVIRONMENT_NOT_FOUND',
      'FILE_NOT_FOUND',
      'PARSE_ERROR',
      'SCRIPT_FAILED',
      'REQUEST_CANCELLED',
      'INTERNAL_ERROR',
      'RESERVED_VARIABLE_NAME'
    ]
    for (const code of codes) {
      expect(new CoreError(code, code).code).toBe(code)
    }
  })
})
