import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CliError } from '../../errors'
import { EXIT } from '../../exit-codes'
import { expandPaths } from './expand-paths'

/**
 * `<root>/my-api` is the workspace; `<root>` plays "outside the workspace".
 * Only the layout matters here — expansion never reads the workspace marker.
 */
let root: string
let ws: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fp-expand-'))
  ws = join(root, 'my-api')
  mkdirSync(join(ws, 'requests', 'auth'), { recursive: true })
  writeFileSync(join(ws, 'requests', 'a.http'), 'GET http://x/a\n')
  writeFileSync(join(ws, 'requests', 'auth', 'login.http'), 'GET http://x/login\n')
  writeFileSync(join(ws, 'notes.txt'), 'not a request\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof CliError) return err
    throw err
  }
  throw new Error('expected expandPaths to reject')
}

const ALL = (): string[] => [
  join(ws, 'requests', 'a.http'),
  join(ws, 'requests', 'auth', 'login.http')
]

describe('expandPaths — default target', () => {
  it('runs the workspace requests/ tree when no path is given, from a workspace subfolder', async () => {
    expect(await expandPaths([], join(ws, 'requests', 'auth'), ws)).toEqual(ALL())
  })

  it('runs the workspace requests/ tree when no path is given, from outside the workspace', async () => {
    expect(await expandPaths([], root, ws)).toEqual(ALL())
  })

  it('ignores a requests/ folder in the current directory when no path is given', async () => {
    mkdirSync(join(root, 'requests'))
    writeFileSync(join(root, 'requests', 'stray.http'), 'GET http://x/stray\n')
    expect(await expandPaths([], root, ws)).toEqual(ALL())
  })

  it('exits 5 naming the workspace requests folder when it does not exist', async () => {
    rmSync(join(ws, 'requests'), { recursive: true, force: true })
    const err = await rejection(expandPaths([], root, ws))
    expect(err.exitCode).toBe(EXIT.PATH_NOT_FOUND)
    expect(err.message).toContain(join(ws, 'requests'))
    expect(err.hints ?? []).toEqual([])
  })
})

describe('expandPaths — explicit paths', () => {
  it('resolves a relative path against the current directory', async () => {
    expect(await expandPaths(['login.http'], join(ws, 'requests', 'auth'), ws)).toEqual([
      join(ws, 'requests', 'auth', 'login.http')
    ])
  })

  it('suggests the cwd-relative path when a missing file exists relative to the workspace', async () => {
    const err = await rejection(expandPaths(['requests/a.http'], root, ws))
    expect(err.exitCode).toBe(EXIT.PATH_NOT_FOUND)
    expect(err.message).toBe('Path not found: requests/a.http')
    expect(err.hints).toEqual([
      `Did you mean ${basename(ws)}/requests/a.http? Paths are relative to the current directory.`
    ])
  })

  it('suggests a folder the same way, from inside the workspace', async () => {
    const err = await rejection(expandPaths(['requests/auth'], join(ws, 'requests'), ws))
    expect(err.hints).toEqual(['Did you mean auth? Paths are relative to the current directory.'])
  })

  it('gives no suggestion when the path exists nowhere', async () => {
    const err = await rejection(expandPaths(['requests/missing.http'], root, ws))
    expect(err.exitCode).toBe(EXIT.PATH_NOT_FOUND)
    expect(err.hints ?? []).toEqual([])
  })

  it('gives no suggestion for a missing absolute path', async () => {
    const err = await rejection(expandPaths([join(root, 'nope.http')], root, ws))
    expect(err.exitCode).toBe(EXIT.PATH_NOT_FOUND)
    expect(err.hints ?? []).toEqual([])
  })

  it('gives no suggestion when the workspace candidate is not a .http file', async () => {
    const err = await rejection(expandPaths(['notes.txt'], root, ws))
    expect(err.hints ?? []).toEqual([])
  })

  it('rejects an existing file that is not .http, without a suggestion', async () => {
    const err = await rejection(expandPaths(['notes.txt'], ws, ws))
    expect(err.exitCode).toBe(EXIT.PATH_NOT_FOUND)
    expect(err.message).toBe('Not a .http file or folder: notes.txt')
    expect(err.hints ?? []).toEqual([])
  })

  it('reports the first missing path when several are given', async () => {
    const err = await rejection(
      expandPaths(['my-api/requests/a.http', 'requests/auth', 'requests/a.http'], root, ws)
    )
    expect(err.message).toBe('Path not found: requests/auth')
    expect(err.hints).toEqual([
      `Did you mean ${basename(ws)}/requests/auth? Paths are relative to the current directory.`
    ])
  })
})

describe('expandPaths — a target with nothing to run is fatal (exit 19)', () => {
  it('an explicit folder with no .http file', async () => {
    mkdirSync(join(ws, 'requests', 'empty'))
    const err = await rejection(expandPaths(['requests/empty'], ws, ws))
    expect(err.exitCode).toBe(EXIT.NO_REQUESTS)
    expect(err.message).toContain(join(ws, 'requests', 'empty'))
  })

  it('a folder holding only non-.http files and skipped folders', async () => {
    mkdirSync(join(ws, 'requests', 'docs', '.runs'), { recursive: true })
    writeFileSync(join(ws, 'requests', 'docs', 'readme.md'), '# notes\n')
    writeFileSync(join(ws, 'requests', 'docs', '.runs', 'old.http'), 'GET http://x/\n')
    const err = await rejection(expandPaths(['requests/docs'], ws, ws))
    expect(err.exitCode).toBe(EXIT.NO_REQUESTS)
  })

  it('the workspace requests/ folder when no path is given', async () => {
    rmSync(join(ws, 'requests'), { recursive: true, force: true })
    mkdirSync(join(ws, 'requests'))
    const err = await rejection(expandPaths([], root, ws))
    expect(err.exitCode).toBe(EXIT.NO_REQUESTS)
    expect(err.message).toContain(join(ws, 'requests'))
  })

  it('one empty folder among several paths is enough', async () => {
    mkdirSync(join(ws, 'requests', 'empty'))
    const err = await rejection(expandPaths(['requests/a.http', 'requests/empty'], ws, ws))
    expect(err.exitCode).toBe(EXIT.NO_REQUESTS)
  })
})
