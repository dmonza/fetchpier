import { describe, expect, it } from 'vitest'
import { implicitDefaultHeaderEntries } from './implicit-headers'
import type { KeyValuePair } from '../../../shared/types'

const row = (key: string, value: string, enabled = true): KeyValuePair => ({
  id: key,
  key,
  value,
  enabled
})

describe('implicitDefaultHeaderEntries', () => {
  it('shows both defaults, with the app version, when the request has neither', () => {
    expect(implicitDefaultHeaderEntries([row('Accept', 'application/json')], '1.2.3')).toEqual([
      { key: 'User-Agent', value: 'Fetchpier/1.2.3' },
      { key: 'Accept-Encoding', value: 'gzip, deflate, br' }
    ])
  })

  it('hides a default the user wrote, whatever its casing', () => {
    expect(
      implicitDefaultHeaderEntries(
        [row('user-agent', 'Fetchpier/0.1.0'), row('ACCEPT-ENCODING', 'identity')],
        '1.2.3'
      )
    ).toEqual([])
  })

  it('a disabled user header does not suppress the default (it is not sent)', () => {
    expect(
      implicitDefaultHeaderEntries([row('User-Agent', 'x', false)], '1.2.3').map((e) => e.key)
    ).toEqual(['User-Agent', 'Accept-Encoding'])
  })

  it('reads a version-less product token until the app version is known', () => {
    expect(implicitDefaultHeaderEntries([], null)[0]).toEqual({
      key: 'User-Agent',
      value: 'Fetchpier'
    })
  })
})
