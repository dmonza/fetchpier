// End-to-end save/list/get/updateSourceFile tests for the activity-log
// migration (REQ-0068 CA-01 / CA-03 / CA-04 / CA-05 / CA-08 + stale-`.json`
// ignore). These exercise the full pipeline through the temporary
// filesystem; the parser/serializer/binary tests live next to the neutral
// activity-log module.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clear,
  countForPath,
  deleteForPath,
  get,
  list,
  remove,
  save,
  updateSourceFile
} from './history'
import type { HistoryEntry } from '@shared/types'

function uuid(seed: string): string {
  // Deterministic shape — only the format matters for filename hashing.
  return `${seed.padEnd(8, '0')}-1111-2222-3333-${seed.padEnd(12, '0')}`
}

function buildEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: overrides.id ?? uuid('a'),
    timestamp: overrides.timestamp ?? '2026-05-15T14:23:04.123Z',
    sourceFile: overrides.sourceFile ?? 'requests/auth/login.http',
    requestId: overrides.requestId,
    request: {
      method: 'POST',
      url: 'https://api.example.com/auth/login',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'sid=abc123'
      },
      body: '{"user":"juan"}',
      ...overrides.request
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'refresh=def456; Path=/; HttpOnly'
      },
      body: '{"token":"ey..."}',
      timingMs: 184,
      sizeBytes: 20,
      ...overrides.response
    },
    scriptResults: overrides.scriptResults,
    resolvedSettings: overrides.resolvedSettings,
    cookies: overrides.cookies,
    remoteIp: overrides.remoteIp
  }
}

describe('workspace.history (REQ-0068)', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'core-history-'))
  })
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  it('CA-01: save() writes a `.http` and no `.json`', async () => {
    await save(ws, buildEntry())
    const files = await fs.readdir(join(ws, 'requests', '.runs'))
    expect(files.length).toBe(1)
    expect(files[0]!.endsWith('.http')).toBe(true)
    expect(files.some((f) => f.endsWith('.json'))).toBe(false)
  })

  it('CA-03: metadata is preserved (directives + @settings block + cookies in headers)', async () => {
    const entry = buildEntry({
      requestId: uuid('r'),
      resolvedSettings: {
        httpVersion: 'auto',
        verifySsl: false,
        followRedirects: true,
        maxRedirects: 5,
        followAuthorizationOnRedirect: false,
        encodeUrl: true,
        disableCookieJar: false
      },
      remoteIp: '203.0.113.42'
    })
    await save(ws, entry)
    const text = await get(ws, entry.id)
    expect(text).toContain(`# @timestamp: ${entry.timestamp}`)
    expect(text).toContain(`# @run-id: ${entry.id}`)
    expect(text).toContain(`# @request-id: ${entry.requestId}`)
    expect(text).toContain(`# @source-file: ${entry.sourceFile}`)
    expect(text).toContain(`# @duration-ms: 184`)
    expect(text).toContain(`# @path-raw: ${entry.request.url}`)
    expect(text).toContain(`# @remote-ip: 203.0.113.42`)
    expect(text).toContain('# @settings')
    expect(text).toContain('# verifySsl: false')
    expect(text).toContain('# httpVersion: auto')
    expect(text).toContain('# @end-settings')
    // Cookies live in headers, not in directives.
    expect(text).toContain('Cookie: sid=abc123')
    expect(text).toContain('Set-Cookie: refresh=def456; Path=/; HttpOnly')
    expect(text).not.toMatch(/# @cookies/)
  })

  it('CA-04: script-results block lives after the response with pass/fail lines', async () => {
    const entry = buildEntry({
      scriptResults: {
        postResponse: {
          success: false,
          logs: [
            { level: 'log', args: ['token = "ey..."'], timestamp: '' },
            { level: 'warn', args: ['unresolved variable {{baseUrl}}'], timestamp: '' }
          ],
          testResults: [
            { name: 'response is JSON', passed: true },
            { name: 'status is 201', passed: false, error: 'expected 201, got 200' }
          ]
        }
      }
    })
    await save(ws, entry)
    const text = await get(ws, entry.id)
    const respIdx = text.indexOf('### Response')
    const blockIdx = text.indexOf('# @script-results: post-response')
    expect(respIdx).toBeGreaterThan(0)
    expect(blockIdx).toBeGreaterThan(respIdx)
    expect(text).toContain('# log: token = "ey..."')
    expect(text).toContain('# warn: unresolved variable {{baseUrl}}')
    expect(text).toContain('# pass: response is JSON')
    expect(text).toContain('# fail: status is 201 — expected 201, got 200')
    expect(text).toContain('# @end-script-results')
  })

  it('CA-05: binary response body is replaced by the placeholder line', async () => {
    const entry = buildEntry({
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: '\x00\x01\x02\x03binary-blob\x04\x05',
        timingMs: 99,
        sizeBytes: 18
      }
    })
    await save(ws, entry)
    const text = await get(ws, entry.id)
    expect(text).toMatch(/\[binary body, \d+ bytes, content-type: application\/octet-stream\]/)
    expect(text).not.toContain('binary-blob')
  })

  it('CA-06 / CA-08: same-ms sends produce different filenames (hash slot); updateSourceFile preserves the rest', async () => {
    const entryA = buildEntry({ id: uuid('alpha') })
    const entryB = buildEntry({ id: uuid('bravo') })
    await save(ws, entryA)
    await save(ws, entryB)
    const files = (await fs.readdir(join(ws, 'requests', '.runs'))).sort()
    expect(files.length).toBe(2)
    expect(files[0]).not.toBe(files[1])

    const beforeA = await get(ws, entryA.id)
    await updateSourceFile(ws, 'requests/auth/login.http', 'requests/auth/sign-in.http', false)
    const afterA = await get(ws, entryA.id)
    expect(afterA).toContain('# @source-file: requests/auth/sign-in.http')
    expect(afterA).not.toContain('# @source-file: requests/auth/login.http')
    // Everything else identical: replace only the source-file directive in the
    // before-text and the result must equal after.
    const expected = beforeA.replace(
      '# @source-file: requests/auth/login.http',
      '# @source-file: requests/auth/sign-in.http'
    )
    expect(afterA).toBe(expected)
  })

  // HIS-12: a rename rewrites the source-file line as text. Bodies that are
  // not in the parser's canonical layout keep every byte.
  it.each<
    [
      string,
      { request?: Partial<HistoryEntry['request']>; response?: Partial<HistoryEntry['response']> }
    ]
  >([
    [
      'a CRLF response body',
      { response: { headers: { 'Content-Type': 'text/csv' }, body: 'id,name\r\n1,a\r\n2,b\r\n' } }
    ],
    ['a request body with a separator line', { request: { body: 'line1\n### Response\nline2' } }],
    [
      'a response body ending in a block lookalike',
      { response: { headers: { 'Content-Type': 'text/plain' }, body: 'ok\n# @x\n# y\n# @end-x' } }
    ],
    [
      'a response body quoting the source-file directive',
      {
        response: {
          headers: { 'Content-Type': 'text/plain' },
          body: '# @source-file: requests/auth/login.http'
        }
      }
    ]
  ])('updateSourceFile keeps %s byte-identical', async (_label, overrides) => {
    const base = buildEntry({ id: uuid('echo') })
    const entry = buildEntry({
      id: base.id,
      request: { ...base.request, ...overrides.request },
      response: { ...base.response, ...overrides.response }
    })
    await save(ws, entry)
    const before = await get(ws, entry.id)

    await updateSourceFile(ws, 'requests/auth/login.http', 'requests/auth/sign-in.http', false)

    expect(await get(ws, entry.id)).toBe(
      before.replace(
        '# @source-file: requests/auth/login.http',
        '# @source-file: requests/auth/sign-in.http'
      )
    )
  })

  it('updateSourceFile keeps the line endings of a CRLF run file on a folder move', async () => {
    await save(ws, buildEntry({ id: uuid('foxtrot') }))
    const [file] = await fs.readdir(join(ws, 'requests', '.runs'))
    const filepath = join(ws, 'requests', '.runs', file!)
    const crlf = (await fs.readFile(filepath, 'utf-8')).replace(/\n/g, '\r\n')
    await fs.writeFile(filepath, crlf, 'utf-8')

    await updateSourceFile(ws, 'requests/auth', 'requests/identity', true)

    expect(await fs.readFile(filepath, 'utf-8')).toBe(
      crlf.replace(
        '# @source-file: requests/auth/login.http\r\n',
        '# @source-file: requests/identity/login.http\r\n'
      )
    )
  })

  // Atomic writes — closing the write-safety coverage gap: these writers used
  // to do a direct fs.writeFile with no temp file at all.
  it('updateSourceFile leaves the previous entry intact when the write is interrupted (CA-04)', async () => {
    const entry = buildEntry({ id: uuid('gamma') })
    await save(ws, entry)
    const before = await get(ws, entry.id)

    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('ENOSPC: simulated disk full'))

    await expect(
      updateSourceFile(ws, 'requests/auth/login.http', 'requests/auth/sign-in.http', false)
    ).rejects.toThrow(/ENOSPC/)
    renameSpy.mockRestore()

    expect(await get(ws, entry.id)).toBe(before)
    const files = await fs.readdir(join(ws, 'requests', '.runs'))
    expect(files.every((f) => f.endsWith('.http'))).toBe(true)
  })

  it('save() retries the rename through a transient error and eventually succeeds (CA-06)', async () => {
    const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
      code: 'EBUSY'
    })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

    const entry = buildEntry({ id: uuid('delta') })
    await save(ws, entry)

    expect(renameSpy).toHaveBeenCalledTimes(2)
    renameSpy.mockRestore()
    expect(await get(ws, entry.id)).toContain(`# @run-id: ${entry.id}`)
  })

  it('list() ignores stale `.json` files left from before the migration', async () => {
    await save(ws, buildEntry())
    // Drop a fake legacy file alongside the new `.http`.
    await fs.writeFile(
      join(ws, 'requests', '.runs', '2026-05-15T14-23-04_POST_legacy.json'),
      JSON.stringify({ id: 'legacy', timestamp: '2026-05-15T14:23:04Z' }),
      'utf-8'
    )
    const items = await list(ws)
    expect(items.length).toBe(1)
    expect(items[0]!.request.method).toBe('POST')
    expect(items[0]!.response.status).toBe(200)
  })

  it('list({ requestIds }) keeps only those requests and applies the limit after filtering', async () => {
    // Oldest first: two runs of req-a, one of req-b, then three newer runs of req-other.
    const runs: Array<[string, string]> = [
      ['a1', 'req-a'],
      ['a2', 'req-a'],
      ['b1', 'req-b'],
      ['o1', 'req-other'],
      ['o2', 'req-other'],
      ['o3', 'req-other']
    ]
    for (const [i, [seed, requestId]] of runs.entries()) {
      await save(
        ws,
        buildEntry({ id: uuid(seed), requestId, timestamp: `2026-05-15T14:23:0${i}.000Z` })
      )
    }
    const two = await list(ws, { requestIds: ['req-a', 'req-b'], limit: 2 })
    expect(two.map((e) => e.id)).toEqual([uuid('b1'), uuid('a2')])
    const all = await list(ws, { requestIds: ['req-a', 'req-b'], limit: 50 })
    expect(all.map((e) => e.id)).toEqual([uuid('b1'), uuid('a2'), uuid('a1')])
    // An empty set is no filter, as an absent one.
    expect(await list(ws, { requestIds: [], limit: 2 })).toHaveLength(2)
    expect((await list(ws, { requestIds: [] }))[0]!.id).toBe(uuid('o3'))
  })

  it('clear() removes `.http` files but leaves stale `.json` alone', async () => {
    await save(ws, buildEntry())
    await fs.writeFile(
      join(ws, 'requests', '.runs', '2026-05-15T14-23-04_POST_legacy.json'),
      '{}',
      'utf-8'
    )
    await clear(ws)
    const files = await fs.readdir(join(ws, 'requests', '.runs'))
    expect(files.some((f) => f.endsWith('.http'))).toBe(false)
    expect(files.some((f) => f.endsWith('.json'))).toBe(true)
  })

  it('deleteForPath() removes only entries that match the source-file', async () => {
    await save(ws, buildEntry({ id: uuid('one'), sourceFile: 'requests/auth/login.http' }))
    await save(ws, buildEntry({ id: uuid('two'), sourceFile: 'requests/users/list.http' }))
    await deleteForPath(ws, 'requests/auth/login.http', false)
    const items = await list(ws)
    expect(items.length).toBe(1)
    expect(items[0]!.sourceFile).toBe('requests/users/list.http')
  })

  it('get() throws for unknown ids', async () => {
    await expect(get(ws, 'never-saved')).rejects.toThrow(/not found/i)
  })

  it('lists runs whose method has a hyphen or a digit, as the .http parser accepts (HIS-16)', async () => {
    await save(ws, buildEntry({ id: uuid('get'), request: { method: 'GET' } as never }))
    await save(ws, buildEntry({ id: uuid('vc'), request: { method: 'VERSION-CONTROL' } as never }))
    await save(ws, buildEntry({ id: uuid('m2'), request: { method: 'm2' } as never }))
    const methods = (await list(ws)).map((i) => i.request.method).sort()
    expect(methods).toEqual(['GET', 'M2', 'VERSION-CONTROL'])
  })

  describe('runs over the 5 MB full-read cap (HIS-20)', () => {
    const big = (id: string, sourceFile = 'requests/col/big.http'): HistoryEntry =>
      buildEntry({
        id,
        sourceFile,
        response: { body: 'x'.repeat(6 * 1024 * 1024) } as never
      })

    it('countForPath() counts a large run beside a small one', async () => {
      await save(ws, buildEntry({ id: uuid('small'), sourceFile: 'requests/col/big.http' }))
      await save(ws, big(uuid('large')))
      expect(await countForPath(ws, 'requests/col/big.http', false)).toBe(2)
      expect(await countForPath(ws, 'requests/col', true)).toBe(2)
    })

    it('countForPath() counts a request whose only run is large', async () => {
      await save(ws, big(uuid('large')))
      expect(await countForPath(ws, 'requests/col/big.http', false)).toBe(1)
    })

    it('deleteForPath() deletes the large run too', async () => {
      await save(ws, buildEntry({ id: uuid('small'), sourceFile: 'requests/col/big.http' }))
      await save(ws, big(uuid('large')))
      await save(ws, big(uuid('other'), 'requests/col/keep.http'))
      await deleteForPath(ws, 'requests/col/big.http', false)
      const files = await fs.readdir(join(ws, 'requests', '.runs'))
      expect(files.length).toBe(1)
      expect(await countForPath(ws, 'requests/col/keep.http', false)).toBe(1)
    })

    it('remove() deletes a large run by id', async () => {
      await save(ws, big(uuid('large')))
      await remove(ws, uuid('large'))
      expect(await fs.readdir(join(ws, 'requests', '.runs'))).toEqual([])
    })

    it('updateSourceFile() relinks a large run and keeps its body byte for byte', async () => {
      await save(ws, big(uuid('large')))
      const dir = join(ws, 'requests', '.runs')
      const [file] = await fs.readdir(dir)
      const before = await fs.readFile(join(dir, file!), 'utf-8')
      await updateSourceFile(ws, 'requests/col/big.http', 'requests/col/renamed.http', false)
      const after = await fs.readFile(join(dir, file!), 'utf-8')
      expect(after).toBe(
        before.replace(
          '# @source-file: requests/col/big.http',
          '# @source-file: requests/col/renamed.http'
        )
      )
      expect(await countForPath(ws, 'requests/col/renamed.http', false)).toBe(1)
    })

    it('get() finds a large run but refuses the full read, naming the size cap', async () => {
      await save(ws, big(uuid('large')))
      await expect(get(ws, uuid('large'))).rejects.toThrow(/too large/i)
    })
  })
})
