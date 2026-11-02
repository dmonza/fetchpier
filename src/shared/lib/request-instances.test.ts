import { describe, expect, it } from 'vitest'
import {
  instanceDisplayName,
  instanceFileName,
  isInstanceFileName,
  isValidInstanceName,
  splitInstanceName
} from './request-instances'

describe('request-instances helpers', () => {
  describe('isInstanceFileName', () => {
    it('recognizes instance files', () => {
      expect(isInstanceFileName('login.happy-path.instance.http')).toBe(true)
      expect(isInstanceFileName('login.http')).toBe(false)
      expect(isInstanceFileName('readme.md')).toBe(false)
      // The bare marker (no name before it) is not a valid instance file.
      expect(isInstanceFileName('.instance.http')).toBe(false)
    })
  })

  describe('isValidInstanceName', () => {
    it('accepts letters, digits, hyphens, underscores', () => {
      expect(isValidInstanceName('happy-path')).toBe(true)
      expect(isValidInstanceName('error_401')).toBe(true)
      expect(isValidInstanceName('v2')).toBe(true)
    })
    it('rejects dots, slashes, spaces, and empty', () => {
      expect(isValidInstanceName('has.dot')).toBe(false)
      expect(isValidInstanceName('has/slash')).toBe(false)
      expect(isValidInstanceName('has space')).toBe(false)
      expect(isValidInstanceName('')).toBe(false)
    })
  })

  describe('instanceFileName', () => {
    it('builds the double-extension filename', () => {
      expect(instanceFileName('login', 'happy-path')).toBe('login.happy-path.instance.http')
    })
  })

  describe('splitInstanceName', () => {
    it('binds to the only matching stem', () => {
      expect(splitInstanceName('login.happy-path.instance.http', new Set(['login']))).toEqual({
        parentStem: 'login',
        instanceName: 'happy-path'
      })
    })
    it('binds to the longest matching stem', () => {
      expect(
        splitInstanceName('login.v2.ok.instance.http', new Set(['login', 'login.v2']))
      ).toEqual({ parentStem: 'login.v2', instanceName: 'ok' })
    })
    it('returns null when no parent stem exists', () => {
      expect(splitInstanceName('login.happy-path.instance.http', new Set())).toBeNull()
    })
    it('returns null for a non-instance filename', () => {
      expect(splitInstanceName('login.http', new Set(['login']))).toBeNull()
    })
  })

  describe('instanceDisplayName', () => {
    it('returns the instance-name segment for a grouped instance', () => {
      expect(instanceDisplayName('login.happy-path.instance.http', new Set(['login']))).toBe(
        'happy-path'
      )
    })
    it('returns the whole core for an orphan instance', () => {
      expect(instanceDisplayName('login.happy-path.instance.http', new Set())).toBe(
        'login.happy-path'
      )
    })
  })
})
