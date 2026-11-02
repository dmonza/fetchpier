import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  captureFromResponse as _captureFromResponse,
  clear as _clear,
  deleteJar as _deleteJar,
  getCookieHeaderFor as _getCookieHeaderFor,
  getMatchingCookies as _getMatchingCookies,
  list as _list,
  loadJar as _loadJar,
  matchesRequest,
  remove as _remove,
  saveJar as _saveJar,
  update as _update,
  upsert as _upsert,
  type CookieCaptureResult
} from './cookie-jar'
import type { Cookie, CookieJar } from '@shared/types'

let workspaceDir = ''

// F5: the jar takes the workspace path explicitly (no singleton). These wrappers
// inject the per-test workspace dir so the existing call-sites stay unchanged.
const captureFromResponse = (
  envId: string,
  url: string,
  headers: string[]
): Promise<CookieCaptureResult> => _captureFromResponse(workspaceDir, envId, url, headers)

/**
 * REQ-0115: the parser is no longer part of the module's surface — a function
 * that hands back a cookie the jar would refuse, with no verdict attached, is
 * the shape that caused the defect. Behaviors that used to be asserted against
 * it are asserted here against what actually gets **stored**, which is the thing
 * that matters.
 *
 * Returns the single stored cookie, or null when the header was refused.
 */
async function captureOne(header: string, url: string): Promise<Cookie | null> {
  await clear('dev')
  const res = await _captureFromResponse(workspaceDir, 'dev', url, [header])
  return res.accepted[0] ?? null
}
const clear = (envId: string): Promise<void> => _clear(workspaceDir, envId)
const deleteJar = (envId: string): Promise<void> => _deleteJar(workspaceDir, envId)
const getCookieHeaderFor = (envId: string, url: string): Promise<string> =>
  _getCookieHeaderFor(workspaceDir, envId, url)
const getMatchingCookies = (envId: string, url: string): Promise<Cookie[]> =>
  _getMatchingCookies(workspaceDir, envId, url)
const list = (envId: string): Promise<Cookie[]> => _list(workspaceDir, envId)
const loadJar = (envId: string): Promise<CookieJar> => _loadJar(workspaceDir, envId)
const remove = (envId: string, cookieId: string): Promise<void> =>
  _remove(workspaceDir, envId, cookieId)
const saveJar = (jar: CookieJar): Promise<void> => _saveJar(workspaceDir, jar)
const update = (envId: string, cookieId: string, changes: Partial<Cookie>): Promise<Cookie> =>
  _update(workspaceDir, envId, cookieId, changes)
const upsert = (
  envId: string,
  cookie: Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Cookie> => _upsert(workspaceDir, envId, cookie)

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(join(tmpdir(), 'cookie-jar-test-'))
  // The jar lives inside its environment's folder, which is resolved from the
  // opaque identifier — so the environment has to exist for a jar to be
  // addressable at all. `dev` is a legacy-shaped environment (id === folder).
  const envDir = join(workspaceDir, 'environments', 'dev')
  await fs.mkdir(envDir, { recursive: true })
  await fs.writeFile(
    join(envDir, 'config.json'),
    JSON.stringify({ id: 'dev', name: 'dev', variables: {} })
  )
})

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true })
})

function baseCookie(partial: Partial<Cookie> = {}): Cookie {
  return {
    id: 'id-1',
    name: 'a',
    value: 'b',
    domain: 'example.com',
    path: '/',
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'manual',
    ...partial
  }
}

describe('Set-Cookie capture — attributes as stored', () => {
  it('stores name, value and every attribute', async () => {
    const stored = await captureOne(
      'sid=abc; Domain=example.com; Path=/app; Secure; HttpOnly; SameSite=Lax; Max-Age=3600',
      'https://api.example.com/app/list'
    )
    expect(stored).not.toBeNull()
    expect(stored!.name).toBe('sid')
    expect(stored!.value).toBe('abc')
    expect(stored!.domain).toBe('example.com')
    expect(stored!.path).toBe('/app')
    expect(stored!.secure).toBe(true)
    expect(stored!.httpOnly).toBe(true)
    expect(stored!.sameSite).toBe('Lax')
    expect(stored!.maxAge).toBe(3600)
    // An explicit Domain means the cookie also covers subdomains.
    expect(stored!.hostOnly).toBe(false)
  })

  it('strips a leading dot on Domain and keeps it a domain cookie', async () => {
    const stored = await captureOne('x=1; Domain=.example.com', 'https://example.com/')
    expect(stored!.domain).toBe('example.com')
    expect(stored!.hostOnly).toBe(false)
  })

  it('binds a cookie with no Domain attribute to the responding host', async () => {
    const stored = await captureOne('x=1', 'https://api.example.com/users/5')
    expect(stored!.domain).toBe('api.example.com')
    expect(stored!.hostOnly).toBe(true)
  })

  it('derives default-path from the request path', async () => {
    const stored = await captureOne('x=1', 'https://example.com/app/list')
    expect(stored!.path).toBe('/app')
  })

  it('refuses a header with no name=value pair', async () => {
    const res = await captureFromResponse('dev', 'https://example.com/', ['Secure; HttpOnly'])
    expect(res.accepted).toHaveLength(0)
    expect(res.rejected).toEqual([
      { name: 'Secure; HttpOnly', host: 'example.com', reason: 'MALFORMED' }
    ])
  })

  it('stores Expires as an ISO date', async () => {
    const stored = await captureOne(
      'x=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT',
      'https://example.com/'
    )
    expect(stored!.expires).toBe(new Date('Wed, 09 Jun 2027 10:18:14 GMT').toISOString())
  })
})

describe('matchesRequest', () => {
  it('matches exact host-only cookie', () => {
    expect(
      matchesRequest(baseCookie({ domain: 'api.example.com' }), 'https://api.example.com/')
    ).toBe(true)
  })

  it('matches subdomain for domain-cookie', () => {
    // REQ-0115: reaching subdomains is now the `hostOnly: false` case only —
    // a cookie captured without a Domain attribute no longer leaks downward.
    expect(
      matchesRequest(
        baseCookie({ domain: 'example.com', hostOnly: false }),
        'https://api.example.com/'
      )
    ).toBe(true)
  })

  it('does not match unrelated domain', () => {
    expect(matchesRequest(baseCookie({ domain: 'foo.com' }), 'https://example.com/')).toBe(false)
  })

  it('matches path prefix', () => {
    expect(matchesRequest(baseCookie({ path: '/app' }), 'https://example.com/app/list')).toBe(true)
    expect(matchesRequest(baseCookie({ path: '/app' }), 'https://example.com/app')).toBe(true)
    expect(matchesRequest(baseCookie({ path: '/app' }), 'https://example.com/application')).toBe(
      false
    )
  })

  it('skips Secure cookie over HTTP', () => {
    expect(matchesRequest(baseCookie({ secure: true }), 'http://example.com/')).toBe(false)
    expect(matchesRequest(baseCookie({ secure: true }), 'https://example.com/')).toBe(true)
  })

  it('skips expired cookies', () => {
    const past = new Date(Date.now() - 10_000).toISOString()
    expect(matchesRequest(baseCookie({ expires: past }), 'https://example.com/')).toBe(false)
  })
})

describe('captureFromResponse (lazy file creation)', () => {
  it('creates the file only when a cookie is captured', async () => {
    const filePath = join(workspaceDir, 'environments', 'dev', '.state', 'cookies.json')
    await expect(fs.access(filePath)).rejects.toBeTruthy()

    await captureFromResponse('dev', 'https://api.example.com/login', ['sid=abc; Path=/'])
    const saved = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    expect(saved.environmentId).toBe('dev')
    expect(saved.cookies).toHaveLength(1)
  })

  it('upserts by (name, domain, path) tuple', async () => {
    await captureFromResponse('dev', 'https://example.com/', ['sid=old; Path=/'])
    await captureFromResponse('dev', 'https://example.com/', ['sid=new; Path=/'])
    const cookies = await list('dev')
    expect(cookies).toHaveLength(1)
    expect(cookies[0].value).toBe('new')
  })
})

describe('getCookieHeaderFor', () => {
  it('returns empty string when no cookies match', async () => {
    const header = await getCookieHeaderFor('dev', 'https://example.com/')
    expect(header).toBe('')
  })

  it('concatenates matching cookies', async () => {
    await upsert('dev', {
      name: 'a',
      value: '1',
      domain: 'example.com',
      path: '/',
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
      hostOnly: true,
      source: 'manual'
    })
    await upsert('dev', {
      name: 'b',
      value: '2',
      domain: 'example.com',
      path: '/',
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
      hostOnly: true,
      source: 'manual'
    })
    const header = await getCookieHeaderFor('dev', 'https://example.com/')
    expect(header.split('; ').sort()).toEqual(['a=1', 'b=2'])
  })
})

describe('loadJar cleans expired cookies on read', () => {
  it('filters and persists cleaned jar', async () => {
    await upsert('dev', {
      name: 'old',
      value: '1',
      domain: 'example.com',
      path: '/',
      expires: new Date(Date.now() - 1000).toISOString(),
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
      hostOnly: true,
      source: 'manual'
    })
    const jar = await loadJar('dev')
    expect(jar.cookies).toHaveLength(0)
  })
})

describe('clear', () => {
  it('deletes the jar file', async () => {
    await captureFromResponse('dev', 'https://example.com/', ['sid=abc'])
    await clear('dev')
    const matching = await getMatchingCookies('dev', 'https://example.com/')
    expect(matching).toHaveLength(0)
  })

  it('is idempotent when the file does not exist', async () => {
    await clear('dev')
    await clear('dev') // second call must not throw
  })
})

// ── Coverage-gap additions (REQ-0055 §4.3.2) ───────────────────────────────

describe('environment id safety', () => {
  // The identifier is opaque and is never a path segment: it is resolved to a
  // folder first, and a path-shaped identifier resolves to nothing. The jar is
  // therefore unreachable rather than escaping — the folder it would have
  // addressed is never built.
  it('rejects a path-shaped environment id without touching the filesystem', async () => {
    await expect(list('../escape')).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' })
    await expect(captureFromResponse('a/b', 'https://x/', ['x=1'])).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
  })

  it('rejects an identifier no environment folder holds', async () => {
    await expect(list('ghost')).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' })
  })
})

describe('Set-Cookie capture — RFC 6265 §5.2 edges', () => {
  const refused = async (header: string, url = 'https://example.com/'): Promise<boolean> => {
    await clear('dev')
    const res = await captureFromResponse('dev', url, [header])
    return res.accepted.length === 0
  }

  it('refuses a header with no name=value pair at all', async () => {
    expect(await refused('Secure; HttpOnly; SameSite=Strict')).toBe(true)
  })

  it('refuses a pair with an empty name', async () => {
    expect(await refused('=value; Path=/')).toBe(true)
  })

  it('refuses an empty header', async () => {
    expect(await refused('')).toBe(true)
    expect(await refused('   ')).toBe(true)
  })

  it('ignores a non-finite Max-Age', async () => {
    expect((await captureOne('x=1; Max-Age=NaN', 'https://example.com/'))!.maxAge).toBeNull()
  })

  it('ignores an unparseable Expires date', async () => {
    expect(
      (await captureOne('x=1; Expires=not-a-date', 'https://example.com/'))!.expires
    ).toBeNull()
  })

  it('lowercases the domain after stripping the leading dot', async () => {
    const stored = await captureOne('x=1; Domain=.EXAMPLE.com', 'https://example.com/')
    expect(stored!.domain).toBe('example.com')
  })

  it('falls back to the responding host when Domain is empty', async () => {
    const stored = await captureOne('x=1; Domain=', 'https://api.example.com/')
    expect(stored!.domain).toBe('api.example.com')
    expect(stored!.hostOnly).toBe(true)
  })

  it('falls back to the default path when the Path attribute is empty', async () => {
    const stored = await captureOne('x=1; Path=', 'https://example.com/app/')
    expect(stored!.path).toBe('/app')
  })

  it('default-path is "/" when the request path is the root', async () => {
    expect((await captureOne('x=1', 'https://example.com/'))!.path).toBe('/')
  })

  it('default-path strips the last path segment when nested', async () => {
    expect((await captureOne('x=1', 'https://example.com/a/b/c'))!.path).toBe('/a/b')
  })

  it('recognises the cross-site attribute case-insensitively', async () => {
    expect((await captureOne('x=1; SameSite=strict', 'https://example.com/'))!.sameSite).toBe(
      'Strict'
    )
    expect((await captureOne('x=1; SameSite=LAX', 'https://example.com/'))!.sameSite).toBe('Lax')
    expect((await captureOne('x=1; SameSite=None; Secure', 'https://example.com/'))!.sameSite).toBe(
      'None'
    )
  })

  it('ignores an unknown cross-site value', async () => {
    expect((await captureOne('x=1; SameSite=banana', 'https://example.com/'))!.sameSite).toBeNull()
  })

  it('captures nothing when the responding URL is unparseable', async () => {
    const res = await captureFromResponse('dev', 'not-a-url', ['x=1'])
    expect(res.accepted).toHaveLength(0)
    expect(res.rejected).toHaveLength(0)
  })

  it('ignores unknown attributes silently', async () => {
    const stored = await captureOne(
      'x=1; FunkyAttr=ignored; AnotherUnknown',
      'https://example.com/'
    )
    expect(stored!.value).toBe('1')
  })

  it('preserves an embedded "=" in the value', async () => {
    const stored = await captureOne('token=a=b=c; Path=/', 'https://example.com/')
    expect(stored!.value).toBe('a=b=c')
  })
})

describe('isExpired behaviour (observed via captureFromResponse and loadJar)', () => {
  it('Max-Age=0 cookie is treated as already expired and removed', async () => {
    await captureFromResponse('dev', 'https://example.com/', ['sid=abc; Max-Age=0; Path=/'])
    expect(await list('dev')).toHaveLength(0)
  })

  it('negative Max-Age expires the existing cookie tuple', async () => {
    await captureFromResponse('dev', 'https://example.com/', ['sid=keep; Path=/'])
    expect(await list('dev')).toHaveLength(1)
    await captureFromResponse('dev', 'https://example.com/', ['sid=gone; Max-Age=-10; Path=/'])
    expect(await list('dev')).toHaveLength(0)
  })

  it('Max-Age takes precedence over Expires', async () => {
    // Max-Age=3600 keeps the cookie alive even though Expires is in the past.
    await captureFromResponse('dev', 'https://example.com/', [
      'sid=alive; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'
    ])
    expect(await list('dev')).toHaveLength(1)
  })

  it('past Expires drops the cookie when Max-Age is absent', async () => {
    await captureFromResponse('dev', 'https://example.com/', [
      'sid=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'
    ])
    expect(await list('dev')).toHaveLength(0)
  })
})

describe('matchesRequest edges', () => {
  it('returns false for an unparseable request URL', () => {
    expect(matchesRequest(baseCookie(), 'not a url')).toBe(false)
  })

  it('rejects when path is a prefix but next char is not "/"', () => {
    // /app prefixes /application but the next char must be "/" for a path match.
    expect(matchesRequest(baseCookie({ path: '/app' }), 'https://example.com/application')).toBe(
      false
    )
  })

  it('matches when cookiePath ends in "/"', () => {
    expect(matchesRequest(baseCookie({ path: '/api/' }), 'https://example.com/api/users')).toBe(
      true
    )
  })
})

describe('captureFromResponse — additional paths', () => {
  it('reports nothing for empty headers without touching the filesystem', async () => {
    const result = await captureFromResponse('dev', 'https://example.com/', [])
    expect(result).toEqual({ accepted: [], rejected: [], crossSiteInsecure: [] })
    const filePath = join(workspaceDir, 'environments', 'dev', '.state', 'cookies.json')
    await expect(fs.access(filePath)).rejects.toBeTruthy()
  })

  it('keeps processing the remaining headers after a refusal', async () => {
    // The "continue on refusal" contract: one bad header must not cost the user
    // the good ones that shared the response.
    const result = await captureFromResponse('dev', 'https://example.com/', [
      'Secure; HttpOnly',
      'valid=ok; Path=/'
    ])
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0].name).toBe('valid')
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toBe('MALFORMED')
  })

  it('removes a pre-existing cookie when the new header expires it', async () => {
    await captureFromResponse('dev', 'https://example.com/', ['sid=alive; Path=/'])
    expect(await list('dev')).toHaveLength(1)
    await captureFromResponse('dev', 'https://example.com/', [
      'sid=tombstone; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'
    ])
    expect(await list('dev')).toHaveLength(0)
  })

  it('preserves createdAt when re-capturing the same tuple', async () => {
    // Drive the clock instead of trusting it to advance. `updatedAt` is
    // `new Date().toISOString()` — millisecond resolution — so on a fast machine
    // both captures land inside the same millisecond and the two strings come
    // out identical. The product is right when that happens; the assertion was
    // the thing assuming real time had passed, and it reddened CI on Linux.
    //
    // `toFake: ['Date']` on purpose: this test does real filesystem work, and
    // faking the timer/IO machinery wholesale risks stalling those promises.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      await captureFromResponse('dev', 'https://example.com/', ['sid=v1; Path=/'])
      const first = (await list('dev'))[0]

      vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
      await captureFromResponse('dev', 'https://example.com/', ['sid=v2; Path=/'])
      const second = (await list('dev'))[0]

      expect(second.createdAt).toBe(first.createdAt)
      expect(second.updatedAt).not.toBe(first.updatedAt)
      expect(second.value).toBe('v2')
      expect(second.id).toBe(first.id)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('upsert, update, remove', () => {
  const base = (
    overrides: Partial<Cookie> = {}
  ): Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'> => ({
    name: 'a',
    value: '1',
    domain: 'example.com',
    path: '/',
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
    source: 'manual',
    ...overrides
  })

  it('upsert assigns a fresh UUID + createdAt on insert', async () => {
    const cookie = await upsert('dev', base())
    expect(cookie.id).toMatch(/^[0-9a-f-]+$/)
    expect(cookie.createdAt).toBeTruthy()
  })

  it('upsert preserves id + createdAt when the tuple already exists', async () => {
    const first = await upsert('dev', base())
    const second = await upsert('dev', base({ value: 'updated' }))
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.value).toBe('updated')
  })

  it('update applies partial changes by cookie id', async () => {
    const created = await upsert('dev', base())
    const updated = await update('dev', created.id, { value: 'changed' })
    expect(updated.id).toBe(created.id)
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.value).toBe('changed')
  })

  it('update throws when id is unknown', async () => {
    await expect(update('dev', 'no-such-id', { value: 'x' })).rejects.toThrow(/Cookie not found/)
  })

  it('remove deletes a specific cookie by id', async () => {
    const c1 = await upsert('dev', base({ name: 'a' }))
    await upsert('dev', base({ name: 'b' }))
    await remove('dev', c1.id)
    const left = await list('dev')
    expect(left.map((c) => c.name)).toEqual(['b'])
  })

  it('remove deletes the jar file once the last cookie is gone', async () => {
    const filePath = join(workspaceDir, 'environments', 'dev', '.state', 'cookies.json')
    const c1 = await upsert('dev', base())
    await expect(fs.access(filePath)).resolves.toBeUndefined()
    await remove('dev', c1.id)
    await expect(fs.access(filePath)).rejects.toBeTruthy()
  })
})

describe('saveJar / loadJar / deleteJar', () => {
  it('saveJar persists an explicit jar and loadJar reads it back', async () => {
    const cookie = baseCookie({ name: 'manual', value: 'set' })
    await saveJar({ environmentId: 'dev', cookies: [cookie] })
    const jar = await loadJar('dev')
    expect(jar.cookies).toHaveLength(1)
    expect(jar.cookies[0].name).toBe('manual')
  })

  it('saveJar with empty cookies is a no-op (does not create the file)', async () => {
    const filePath = join(workspaceDir, 'environments', 'dev', '.state', 'cookies.json')
    await saveJar({ environmentId: 'dev', cookies: [] })
    await expect(fs.access(filePath)).rejects.toBeTruthy()
  })

  it('loadJar tolerates malformed JSON on disk and returns an empty jar', async () => {
    const dir = join(workspaceDir, 'environments', 'dev', '.state')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'cookies.json'), '{ invalid json', 'utf-8')
    const jar = await loadJar('dev')
    expect(jar.cookies).toEqual([])
  })

  it('loadJar tolerates a JSON object whose cookies field is not an array', async () => {
    const dir = join(workspaceDir, 'environments', 'dev', '.state')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, 'cookies.json'),
      JSON.stringify({ environmentId: 'dev', cookies: 'not-an-array' }),
      'utf-8'
    )
    const jar = await loadJar('dev')
    expect(jar.cookies).toEqual([])
  })

  it('deleteJar is an alias for clear', async () => {
    await upsert('dev', {
      name: 'a',
      value: '1',
      domain: 'example.com',
      path: '/',
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
      hostOnly: true,
      source: 'manual'
    })
    await deleteJar('dev')
    expect(await list('dev')).toHaveLength(0)
  })
})

// ── REQ-0115: storage model, host-only matching, lifetime ────────────────────

describe('REQ-0115 — a response may not set a cookie for an unrelated domain', () => {
  it('refuses a Domain the responding host does not belong to (CA-01)', async () => {
    const res = await captureFromResponse('dev', 'https://attacker.test/cb', [
      'sid=chosen-by-them; Domain=victim.test; Path=/'
    ])
    expect(res.accepted).toHaveLength(0)
    expect(res.rejected).toEqual([
      { name: 'sid', host: 'attacker.test', reason: 'DOMAIN_MISMATCH' }
    ])
    expect(await getCookieHeaderFor('dev', 'https://victim.test/admin')).toBe('')
  })

  it('refuses a Domain that merely shares a suffix with the host (CA-01)', async () => {
    // The classic suffix-matching trap: `notexample.test` must not be treated as
    // belonging to `example.test`.
    const res = await captureFromResponse('dev', 'https://notexample.test/', [
      'sid=1; Domain=example.test'
    ])
    expect(res.rejected[0]?.reason).toBe('DOMAIN_MISMATCH')
  })

  it('refuses a single-label public suffix (CA-02)', async () => {
    const res = await captureFromResponse('dev', 'https://anything.com/', ['sid=1; Domain=com'])
    expect(res.accepted).toHaveLength(0)
    expect(res.rejected[0]?.reason).toBe('PUBLIC_SUFFIX')
  })

  it('refuses a multi-label public suffix (CA-02)', async () => {
    const res = await captureFromResponse('dev', 'https://shop.co.uk/', ['sid=1; Domain=co.uk'])
    expect(res.accepted).toHaveLength(0)
    expect(res.rejected[0]?.reason).toBe('PUBLIC_SUFFIX')
  })

  it('accepts the registrable domain of the responding host', async () => {
    const res = await captureFromResponse('dev', 'https://api.example.test/', [
      'sid=1; Domain=example.test'
    ])
    expect(res.accepted).toHaveLength(1)
    expect(res.accepted[0].hostOnly).toBe(false)
  })

  it('accepts a local target, which every fixture in this project uses', async () => {
    const res = await captureFromResponse('dev', 'http://localhost:9200/', ['sid=1'])
    expect(res.accepted).toHaveLength(1)
  })

  it('reports every refusal in a response, not just the first', async () => {
    const res = await captureFromResponse('dev', 'https://attacker.test/', [
      'a=1; Domain=victim.test',
      'b=2; Domain=com',
      'c=3'
    ])
    expect(res.rejected.map((r) => r.name)).toEqual(['a', 'b'])
    expect(res.accepted.map((c) => c.name)).toEqual(['c'])
  })
})

describe('REQ-0115 — host-only matching', () => {
  it('does not send a host-only cookie to a subdomain (CA-03)', async () => {
    await captureFromResponse('dev', 'https://example.test/', ['sid=1'])
    expect(await getCookieHeaderFor('dev', 'https://sub.example.test/')).toBe('')
    expect(await getCookieHeaderFor('dev', 'https://example.test/')).toBe('sid=1')
  })

  it('does not send a host-only cookie to a host sharing its suffix (CA-03)', async () => {
    await captureFromResponse('dev', 'https://example.test/', ['sid=1'])
    expect(await getCookieHeaderFor('dev', 'https://notexample.test/')).toBe('')
  })

  it('sends a domain cookie to the domain and to any subdomain depth (CA-04)', async () => {
    await captureFromResponse('dev', 'https://api.example.test/', ['sid=1; Domain=example.test'])
    expect(await getCookieHeaderFor('dev', 'https://example.test/')).toBe('sid=1')
    expect(await getCookieHeaderFor('dev', 'https://api.example.test/')).toBe('sid=1')
    expect(await getCookieHeaderFor('dev', 'https://deep.api.example.test/')).toBe('sid=1')
  })
})

describe('REQ-0115 — a relative lifetime runs from the last capture (CA-05)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('restarts the interval when the cookie is offered again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await captureFromResponse('dev', 'https://example.test/', ['sid=1; Max-Age=3600'])

    // Half-way through: the server refreshes the sliding session.
    vi.setSystemTime(new Date('2026-01-01T00:30:00Z'))
    await captureFromResponse('dev', 'https://example.test/', ['sid=1; Max-Age=3600'])

    // Past the ORIGINAL deadline but inside the refreshed one. Before REQ-0115 the
    // cookie was dropped here while the server still considered it valid.
    vi.setSystemTime(new Date('2026-01-01T01:10:00Z'))
    expect(await getCookieHeaderFor('dev', 'https://example.test/')).toBe('sid=1')

    // Past the refreshed deadline too.
    vi.setSystemTime(new Date('2026-01-01T01:40:00Z'))
    expect(await getCookieHeaderFor('dev', 'https://example.test/')).toBe('')
  })
})

describe('REQ-0115 — secure cookies are left alone (CA-09)', () => {
  const seedSecure = async (): Promise<void> => {
    await captureFromResponse('dev', 'https://example.test/', ['sid=safe; Secure; Path=/'])
  }

  it('refuses an insecure overwrite of a stored Secure cookie', async () => {
    await seedSecure()
    const res = await captureFromResponse('dev', 'http://example.test/', ['sid=hijacked; Path=/'])
    expect(res.rejected[0]).toEqual({
      name: 'sid',
      host: 'example.test',
      reason: 'INSECURE_OVERWRITE'
    })
    expect((await list('dev'))[0].value).toBe('safe')
  })

  it('allows the overwrite over a secure connection', async () => {
    await seedSecure()
    const res = await captureFromResponse('dev', 'https://example.test/', ['sid=rotated; Path=/'])
    expect(res.rejected).toHaveLength(0)
    expect((await list('dev'))[0].value).toBe('rotated')
  })

  it('does not guard a cookie that is not Secure', async () => {
    await captureFromResponse('dev', 'https://example.test/', ['sid=plain; Path=/'])
    const res = await captureFromResponse('dev', 'http://example.test/', ['sid=next; Path=/'])
    expect(res.rejected).toHaveLength(0)
    expect((await list('dev'))[0].value).toBe('next')
  })

  it('does not fire when nothing is stored', async () => {
    const res = await captureFromResponse('dev', 'http://example.test/', ['sid=first; Path=/'])
    expect(res.rejected).toHaveLength(0)
    expect(res.accepted).toHaveLength(1)
  })

  it('does not fire when the stored Secure cookie sits on an unrelated path', async () => {
    // An over-broad guard would refuse this and silently block a legitimate cookie.
    await captureFromResponse('dev', 'https://example.test/admin/x', [
      'sid=safe; Secure; Path=/admin'
    ])
    const res = await captureFromResponse('dev', 'http://example.test/public/y', [
      'sid=other; Path=/public'
    ])
    expect(res.rejected).toHaveLength(0)
    expect(res.accepted).toHaveLength(1)
  })
})

describe('REQ-0115 — security-prefixed names (CA-10)', () => {
  it.each([
    ['__Secure-a=1; Secure', true],
    ['__Secure-a=1', false],
    ['__Host-a=1; Secure; Path=/', true],
    ['__Host-a=1; Path=/', false],
    ['__Host-a=1; Secure; Path=/nested', false],
    ['__Host-a=1; Secure; Path=/; Domain=example.test', false]
  ])('%s -> accepted: %s', async (header, accepted) => {
    await clear('dev')
    const res = await captureFromResponse('dev', 'https://example.test/', [header as string])
    expect(res.accepted).toHaveLength(accepted ? 1 : 0)
    if (!accepted) expect(res.rejected[0]?.reason).toBe('PREFIX_VIOLATION')
  })
})

describe('REQ-0115 — the cross-site attribute is fidelity, not a filter', () => {
  it('sends a Strict cookie like any other (CA-11)', async () => {
    await captureFromResponse('dev', 'https://example.test/', ['sid=1; SameSite=Strict'])
    expect(await getCookieHeaderFor('dev', 'https://example.test/')).toBe('sid=1')
    expect((await list('dev'))[0].sameSite).toBe('Strict')
  })

  it('stores None-without-Secure and reports it (CA-12)', async () => {
    const res = await captureFromResponse('dev', 'https://example.test/', ['sid=1; SameSite=None'])
    expect(res.accepted).toHaveLength(1)
    expect(res.crossSiteInsecure).toEqual([{ name: 'sid', host: 'example.test' }])
  })

  it('does not report None with Secure', async () => {
    const res = await captureFromResponse('dev', 'https://example.test/', [
      'sid=1; SameSite=None; Secure'
    ])
    expect(res.crossSiteInsecure).toHaveLength(0)
  })
})

describe('REQ-0115 — hand-authored cookies', () => {
  const authored = (over: Partial<Cookie>): Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'> => {
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      ...rest
    } = baseCookie({
      source: 'manual',
      ...over
    })
    return rest
  }

  it('is not origin-validated (CA-13)', async () => {
    const created = await upsert('dev', authored({ name: 'manual', domain: 'anything.test' }))
    expect(created.domain).toBe('anything.test')
    expect(created.hostOnly).toBe(true)
  })

  it('normalizes a leading dot into a domain cookie (CA-14)', async () => {
    const created = await upsert('dev', authored({ name: 'wide', domain: '.example.test' }))
    expect(created.domain).toBe('example.test')
    expect(created.hostOnly).toBe(false)
    // Before REQ-0115 the dot was stored verbatim and matched nothing at all.
    expect(await getCookieHeaderFor('dev', 'https://sub.example.test/')).toBe('wide=b')
    expect(await getCookieHeaderFor('dev', 'https://example.test/')).toBe('wide=b')
  })
})

describe('REQ-0115 — jars written before this change (CA-15)', () => {
  it('reads a record with no hostOnly field as bound to its exact host', async () => {
    const legacy = baseCookie({ name: 'old', domain: 'example.test' }) as Partial<Cookie>
    delete legacy.hostOnly
    await fs.mkdir(join(workspaceDir, 'environments', 'dev', '.state'), { recursive: true })
    await fs.writeFile(
      join(workspaceDir, 'environments', 'dev', '.state', 'cookies.json'),
      JSON.stringify({ environmentId: 'dev', cookies: [legacy] })
    )
    expect((await list('dev'))[0].hostOnly).toBe(true)
    expect(await getCookieHeaderFor('dev', 'https://sub.example.test/')).toBe('')
    expect(await getCookieHeaderFor('dev', 'https://example.test/')).toBe('old=b')
  })
})
