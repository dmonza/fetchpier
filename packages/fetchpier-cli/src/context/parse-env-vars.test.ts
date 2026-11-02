import { describe, it, expect } from 'vitest'
import { parseEnvVars } from './parse-env-vars'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

describe('parseEnvVars', () => {
  it('returns an empty record for undefined', () => {
    expect(parseEnvVars(undefined)).toEqual({})
  })

  it('parses KEY=VALUE pairs', () => {
    expect(parseEnvVars(['token=abc', 'host=example.com'])).toEqual({
      token: 'abc',
      host: 'example.com'
    })
  })

  it('keeps `=` inside the value', () => {
    expect(parseEnvVars(['q=a=b=c'])).toEqual({ q: 'a=b=c' })
  })

  it('allows an empty value', () => {
    expect(parseEnvVars(['empty='])).toEqual({ empty: '' })
  })

  it('rejects a pair without `=` with exit 7', () => {
    try {
      parseEnvVars(['TOKEN'])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).exitCode).toBe(EXIT.ENV_VAR)
      expect((err as CliError).message).toContain("got 'TOKEN'")
    }
  })

  it('rejects a pair with an empty key', () => {
    expect(() => parseEnvVars(['=value'])).toThrow(CliError)
  })
})
