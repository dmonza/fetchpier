import { describe, expect, it } from 'vitest'
import { buildActivityLogFilename, hash4 } from './filename'

describe('hash4', () => {
  it('returns a 4-char lowercase hex string', () => {
    const h = hash4('hello')
    expect(h).toMatch(/^[0-9a-f]{4}$/)
  })

  it('is deterministic for the same input', () => {
    expect(hash4('same-input')).toBe(hash4('same-input'))
  })

  it('differs across inputs with high probability', () => {
    // Two arbitrary UUIDs should almost never collide on a 16-bit hash.
    const a = hash4('0c0e1234-1111-2222-3333-444455556666')
    const b = hash4('9e3a5678-aaaa-bbbb-cccc-ddddeeeeffff')
    expect(a).not.toBe(b)
  })

  it('handles non-ASCII input', () => {
    expect(hash4('héllo €')).toMatch(/^[0-9a-f]{4}$/)
  })
})

describe('buildActivityLogFilename', () => {
  const ts = '2026-05-15T14:23:04.123Z'
  const runIdA = '0c0e1234-1111-2222-3333-444455556666'
  const runIdB = '9e3a5678-aaaa-bbbb-cccc-ddddeeeeffff'

  it('uses ISO basic-format UTC timestamp with ms precision', () => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 0,
      method: 'GET',
      pathRaw: '/api/users'
    })
    // 20260515T142304123Z-<hash4>-GET-api_users.http
    expect(name).toMatch(/^20260515T142304123Z-[0-9a-f]{4}-GET-api_users\.http$/)
  })

  it('uses counter as 5-digit disambiguator when counter > 0', () => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 42,
      method: 'POST',
      pathRaw: '/orders'
    })
    expect(name).toBe('20260515T142304123Z-00042-POST-orders.http')
  })

  it('uses hash4(runId) as disambiguator when counter is 0', () => {
    const expectedHash = hash4(runIdA)
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 0,
      method: 'GET',
      pathRaw: '/health'
    })
    expect(name).toBe(`20260515T142304123Z-${expectedHash}-GET-health.http`)
  })

  it('two sends in the same ms with different runIds produce different filenames', () => {
    const a = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 0,
      method: 'GET',
      pathRaw: '/x'
    })
    const b = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdB,
      counter: 0,
      method: 'GET',
      pathRaw: '/x'
    })
    expect(a).not.toBe(b)
    // And the hash slot is what differs.
    expect(a.slice(0, 'YYYYMMDDTHHMMSSmmmZ-'.length)).toBe(
      b.slice(0, 'YYYYMMDDTHHMMSSmmmZ-'.length)
    )
  })

  it('strips query string from the slug', () => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'GET',
      pathRaw: '/api/items?limit=10&offset=0'
    })
    expect(name).toBe('20260515T142304123Z-00001-GET-api_items.http')
  })

  it('replaces / with _ and unsafe chars with _ then collapses', () => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'GET',
      pathRaw: '/a b/c@d/e//f'
    })
    expect(name).toBe('20260515T142304123Z-00001-GET-a_b_c_d_e_f.http')
  })

  it.each([
    ['/__foo__/', 'foo'],
    ['/_/foo', 'foo'],
    ['/foo/_', 'foo'],
    ['/a__b', 'a_b'],
    ['/%20', '20'],
    ['/___', 'root']
  ])('trims separators at the edges of the slug for %j', (pathRaw, slug) => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'GET',
      pathRaw
    })
    expect(name).toBe(`20260515T142304123Z-00001-GET-${slug}.http`)
  })

  it('returns "root" for empty path', () => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'GET',
      pathRaw: '/'
    })
    expect(name).toBe('20260515T142304123Z-00001-GET-root.http')
  })

  it('accepts full URLs and strips scheme + host', () => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'GET',
      pathRaw: 'https://api.example.com/users/42'
    })
    expect(name).toBe('20260515T142304123Z-00001-GET-users_42.http')
  })

  it('uppercases and ASCII-only-letters the method', () => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'get7',
      pathRaw: '/x'
    })
    expect(name).toBe('20260515T142304123Z-00001-GET-x.http')
  })

  it('falls back to UNKNOWN for empty methods', () => {
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: '',
      pathRaw: '/x'
    })
    expect(name).toBe('20260515T142304123Z-00001-UNKNOWN-x.http')
  })

  it('truncates and adds hash4(pathRaw) when the total exceeds 200 chars', () => {
    const longPath = '/' + 'a'.repeat(500)
    const name = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'GET',
      pathRaw: longPath
    })
    expect(name.length).toBeLessThanOrEqual(200)
    expect(name).toMatch(/-[0-9a-f]{4}\.http$/)
    expect(name.startsWith('20260515T142304123Z-00001-GET-')).toBe(true)
  })

  it('truncates differently for paths with the same prefix but different suffixes', () => {
    // Both truncated to the same slug head, but pathRaw differs → different hash.
    const a = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'GET',
      pathRaw: '/' + 'a'.repeat(500) + 'X'
    })
    const b = buildActivityLogFilename({
      timestamp: ts,
      runId: runIdA,
      counter: 1,
      method: 'GET',
      pathRaw: '/' + 'a'.repeat(500) + 'Y'
    })
    expect(a).not.toBe(b)
  })

  it('rejects invalid timestamps with a clear error', () => {
    expect(() =>
      buildActivityLogFilename({
        timestamp: 'not-a-date',
        runId: runIdA,
        counter: 0,
        method: 'GET',
        pathRaw: '/'
      })
    ).toThrow(/invalid timestamp/i)
  })
})
