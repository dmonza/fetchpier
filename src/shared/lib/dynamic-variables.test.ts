import { describe, it, expect } from 'vitest'
import {
  DYNAMIC_VARIABLE_NAMES,
  isDynamicVariableName,
  isReservedVariableName,
  RESERVED_VARIABLE_NAME_PREFIX
} from './dynamic-variables'

describe('dynamic-variables (shared)', () => {
  it('reserves the whole `$` prefix', () => {
    expect(RESERVED_VARIABLE_NAME_PREFIX).toBe('$')
  })

  describe('isReservedVariableName', () => {
    it('rejects any name beginning with `$` (after trim)', () => {
      expect(isReservedVariableName('$myVar')).toBe(true)
      expect(isReservedVariableName('  $x')).toBe(true)
      expect(isReservedVariableName('$guid')).toBe(true)
      expect(isReservedVariableName('$env.FOO')).toBe(true)
    })
    it('allows ordinary user names', () => {
      expect(isReservedVariableName('baseUrl')).toBe(false)
      expect(isReservedVariableName('token$')).toBe(false)
      expect(isReservedVariableName('a$b')).toBe(false)
    })
  })

  describe('isDynamicVariableName', () => {
    it('matches every name in the registry', () => {
      for (const name of DYNAMIC_VARIABLE_NAMES) {
        expect(isDynamicVariableName(name)).toBe(true)
      }
    })
    it('trims surrounding whitespace before matching', () => {
      expect(isDynamicVariableName('  $guid ')).toBe(true)
    })
    it('is case-sensitive', () => {
      expect(isDynamicVariableName('$GUID')).toBe(false)
    })
    it('does not match unknown or non-$ names', () => {
      expect(isDynamicVariableName('$nope')).toBe(false)
      expect(isDynamicVariableName('$env.FOO')).toBe(false)
      expect(isDynamicVariableName('baseUrl')).toBe(false)
    })
  })
})
