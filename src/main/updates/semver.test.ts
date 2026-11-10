import { describe, it, expect } from 'vitest'
import { valid, gt } from './semver'

describe('valid', () => {
  it.each([
    ['1.2.3', '1.2.3'],
    ['0.0.0', '0.0.0'],
    ['10.20.30', '10.20.30'],
    ['v1.2.3', '1.2.3'],
    ['=1.2.3', '1.2.3'],
    ['  1.2.3  ', '1.2.3'],
    ['1.2.3-beta', '1.2.3-beta'],
    ['1.2.3-alpha.1', '1.2.3-alpha.1'],
    ['1.2.3-0a', '1.2.3-0a'],
    ['1.2.3-x-y-z.--', '1.2.3-x-y-z.--'],
    ['1.2.3+build.5', '1.2.3'],
    ['1.2.3-rc.1+sha.abc', '1.2.3-rc.1']
  ])('accepts %j as %j', (input, expected) => {
    expect(valid(input)).toBe(expected)
  })

  it.each([
    [''],
    ['1'],
    ['1.2'],
    ['1.2.3.4'],
    ['01.2.3'],
    ['1.02.3'],
    ['1.2.03'],
    ['1.2.3-01'],
    ['1.2.3-'],
    ['1.2.3-alpha..1'],
    ['1.2.3+'],
    ['1.2.3+a..b'],
    ['1.2.3-al$pha'],
    ['a.b.c'],
    ['-1.2.3'],
    ['1.2.3 4'],
    ['vv1.2.3'],
    ['9007199254740992.0.0']
  ])('rejects %j', (input) => {
    expect(valid(input)).toBeNull()
  })

  it('rejects strings longer than 256 characters', () => {
    expect(valid(`1.2.3-${'a'.repeat(251)}`)).toBeNull()
    expect(valid(`1.2.3-${'a'.repeat(250)}`)).not.toBeNull()
  })

  it('accepts the largest safe integer as a component', () => {
    expect(valid('9007199254740991.0.0')).toBe('9007199254740991.0.0')
  })
})

describe('gt', () => {
  it.each([
    ['2.0.0', '1.9.9'],
    ['1.1.0', '1.0.9'],
    ['1.0.1', '1.0.0'],
    ['1.10.0', '1.9.0'],
    ['1.0.0', '1.0.0-rc.1'],
    ['1.0.0-alpha.1', '1.0.0-alpha'],
    ['1.0.0-alpha.beta', '1.0.0-alpha.1'],
    ['1.0.0-beta', '1.0.0-alpha.beta'],
    ['1.0.0-beta.11', '1.0.0-beta.2'],
    ['1.0.0-rc.1', '1.0.0-beta.11'],
    ['1.0.0-a', '1.0.0-9'],
    ['1.0.0-B', '1.0.0-A'],
    ['v0.9.8', '0.9.7']
  ])('%j > %j', (a, b) => {
    expect(gt(a, b)).toBe(true)
    expect(gt(b, a)).toBe(false)
  })

  it.each([
    ['1.2.3', '1.2.3'],
    ['1.2.3+a', '1.2.3+b'],
    ['1.0.0-rc.1', '1.0.0-rc.1']
  ])('%j is not greater than %j', (a, b) => {
    expect(gt(a, b)).toBe(false)
  })

  it('throws on an invalid version', () => {
    expect(() => gt('1.2', '1.2.3')).toThrow(TypeError)
    expect(() => gt('1.2.3', 'nope')).toThrow(TypeError)
  })
})
