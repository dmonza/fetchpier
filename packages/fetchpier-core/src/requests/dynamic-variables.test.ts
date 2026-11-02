import { describe, it, expect } from 'vitest'
import { DYNAMIC_VARIABLE_NAMES } from '@shared/lib/dynamic-variables'
import { generateDynamicVariable, dynamicGeneratorNames } from './dynamic-variables'

describe('generateDynamicVariable', () => {
  it('returns undefined for an unknown system token', () => {
    expect(generateDynamicVariable('$definitelyNotAToken')).toBeUndefined()
  })

  it('returns undefined for a $env.* reference (interpreted only in env values)', () => {
    expect(generateDynamicVariable('$env.FOO')).toBeUndefined()
  })

  it('keeps the generator registry in sync with the shared name list', () => {
    expect(dynamicGeneratorNames().sort()).toEqual([...DYNAMIC_VARIABLE_NAMES].sort())
  })

  // Parametric shape test over the §6.1 registry: each token generates a value
  // matching its stated shape.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const shapes: Array<[string, (v: string) => void]> = [
    ['$guid', (v) => expect(v).toMatch(UUID_RE)],
    ['$randomUUID', (v) => expect(v).toMatch(UUID_RE)],
    [
      '$timestamp',
      (v) => {
        expect(v).toMatch(/^\d+$/)
        expect(Number(v)).toBeGreaterThan(1_000_000_000)
      }
    ],
    ['$isoTimestamp', (v) => expect(new Date(v).toISOString()).toBe(v)],
    [
      '$randomInt',
      (v) => {
        const n = Number(v)
        expect(Number.isInteger(n)).toBe(true)
        expect(n).toBeGreaterThanOrEqual(0)
        expect(n).toBeLessThanOrEqual(1000)
      }
    ],
    ['$randomBoolean', (v) => expect(['true', 'false']).toContain(v)],
    ['$randomAlphaNumeric', (v) => expect(v).toMatch(/^[A-Za-z0-9]$/)],
    ['$randomHexColor', (v) => expect(v).toMatch(/^#[0-9a-f]{6}$/)],
    ['$randomIP', (v) => expect(v).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/)],
    ['$randomIPV6', (v) => expect(v).toMatch(/^([0-9a-f]{4}:){7}[0-9a-f]{4}$/)],
    ['$randomMACAddress', (v) => expect(v).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)],
    ['$randomPassword', (v) => expect(v).toMatch(/^[A-Za-z0-9]{15}$/)],
    ['$randomSemver', (v) => expect(v).toMatch(/^\d+\.\d+\.\d+$/)]
  ]

  it.each(shapes)('generates a value of the stated shape for %s', (name, assertShape) => {
    const value = generateDynamicVariable(name)
    expect(value).toBeTypeOf('string')
    assertShape(value as string)
  })

  it('every registry token is generatable', () => {
    for (const name of DYNAMIC_VARIABLE_NAMES) {
      expect(generateDynamicVariable(name)).toBeTypeOf('string')
    }
  })

  it('regenerates a fresh value on each call (per-occurrence)', () => {
    const a = new Set(Array.from({ length: 20 }, () => generateDynamicVariable('$guid')))
    // 20 v4 UUIDs are overwhelmingly unique.
    expect(a.size).toBe(20)
  })

  it('bounds $randomInt to 0…1000 across many draws', () => {
    for (let i = 0; i < 500; i++) {
      const n = Number(generateDynamicVariable('$randomInt'))
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(1000)
    }
  })
})
