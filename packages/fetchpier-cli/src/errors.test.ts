import { describe, it, expect } from 'vitest'
import { CoreError } from '@fetchpier/core'
import { CliError, resolveError } from './errors'
import { EXIT } from './exit-codes'

describe('resolveError', () => {
  it('maps a CliError to its own exit code and hints', () => {
    const err = new CliError(EXIT.ENV_VAR, 'bad var', ['hint line'])
    expect(resolveError(err)).toEqual({
      exitCode: EXIT.ENV_VAR,
      message: 'bad var',
      hints: ['hint line']
    })
  })

  it.each([
    ['WORKSPACE_NOT_FOUND', EXIT.WORKSPACE],
    ['WORKSPACE_INVALID', EXIT.WORKSPACE],
    ['ENVIRONMENT_NOT_FOUND', EXIT.ENVIRONMENT],
    ['FILE_NOT_FOUND', EXIT.PATH_NOT_FOUND],
    ['PARSE_ERROR', EXIT.PARSE],
    ['SCRIPT_FAILED', EXIT.TEST_FAILURE],
    ['REQUEST_CANCELLED', EXIT.SIGINT],
    ['INTERNAL_ERROR', EXIT.INTERNAL],
    ['MULTIPART_FILE_TOO_LARGE', EXIT.MULTIPART_FILE_TOO_LARGE],
    ['MULTIPART_FILE_MISSING', EXIT.MULTIPART_FILE_MISSING],
    ['MULTIPART_INVALID_PART', EXIT.MULTIPART_INVALID_PART],
    ['MULTIPART_BOUNDARY_COLLISION', EXIT.MULTIPART_BOUNDARY_COLLISION],
    ['RESERVED_VARIABLE_NAME', EXIT.USAGE]
  ] as const)('maps CoreError %s to exit %i', (code, exit) => {
    const resolved = resolveError(new CoreError(code, `msg ${code}`))
    expect(resolved.exitCode).toBe(exit)
    expect(resolved.message).toBe(`msg ${code}`)
  })

  it('maps an unknown thrown value to exit 255 with a bug hint and stack', () => {
    const resolved = resolveError(new Error('boom'))
    expect(resolved.exitCode).toBe(EXIT.INTERNAL)
    expect(resolved.message).toBe('Internal error: boom')
    expect(resolved.hints.join('\n')).toContain('This is a bug')
    expect(resolved.stack).toBeDefined()
  })

  it('handles non-Error throwables', () => {
    const resolved = resolveError('just a string')
    expect(resolved.exitCode).toBe(EXIT.INTERNAL)
    expect(resolved.message).toBe('Internal error: just a string')
  })
})
