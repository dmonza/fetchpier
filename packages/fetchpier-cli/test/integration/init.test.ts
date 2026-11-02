import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  promises as fs
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../../src/commands/init'
import { CliError } from '../../src/errors'
import { EXIT } from '../../src/exit-codes'

describe('fp init', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fp-init-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('creates a runnable workspace with a default env and starter request', async () => {
    const created = await initWorkspace({ name: 'my-api', cwd: tmp, write: () => {} })
    expect(created).toBe(join(tmp, 'my-api'))
    expect(JSON.parse(readFileSync(join(created, '.fetchpier', 'settings.json'), 'utf-8'))).toEqual(
      {
        version: 1
      }
    )
    const env = JSON.parse(
      readFileSync(join(created, 'environments', 'default', 'config.json'), 'utf-8')
    )
    expect(env.variables.baseUrl).toBe('https://example.com')
    // REQ-0121: core is the single owner of this file now — `init` no longer
    // writes it, so the display name is `Default` and the identifier is the
    // opaque generated one every other environment gets, not the literal
    // `default` this command used to stamp.
    expect(env.name).toBe('Default')
    expect(env.id).not.toBe('default')
    expect(readFileSync(join(created, 'requests', 'example.http'), 'utf-8')).toContain(
      'GET {{baseUrl}}/health'
    )
  })

  it('fails cleanly when the target is already a workspace', async () => {
    await initWorkspace({ name: 'dup', cwd: tmp, write: () => {} })
    await expect(initWorkspace({ name: 'dup', cwd: tmp, write: () => {} })).rejects.toMatchObject({
      exitCode: EXIT.WORKSPACE
    })
    await expect(initWorkspace({ name: 'dup', cwd: tmp, write: () => {} })).rejects.toBeInstanceOf(
      CliError
    )
  })

  // REQ write-safety / CA-08: a folder with seed files but no workspace marker
  // keeps those files intact instead of overwriting them with the stubs.
  it('does not overwrite an existing env config or starter request', async () => {
    const target = join(tmp, 'reinit')
    mkdirSync(join(target, 'environments', 'default'), { recursive: true })
    mkdirSync(join(target, 'requests'), { recursive: true })
    const existingEnv = JSON.stringify({
      id: 'default',
      name: 'default',
      variables: { baseUrl: 'https://kept.example' }
    })
    writeFileSync(join(target, 'environments', 'default', 'config.json'), existingEnv, 'utf-8')
    writeFileSync(
      join(target, 'requests', 'example.http'),
      'GET https://kept/hand-authored',
      'utf-8'
    )

    // No `.fetchpier` marker yet, so init proceeds — but the seeds are guarded.
    await initWorkspace({ name: 'reinit', cwd: tmp, write: () => {} })

    const env = JSON.parse(
      readFileSync(join(target, 'environments', 'default', 'config.json'), 'utf-8')
    )
    expect(env.variables.baseUrl).toBe('https://kept.example')
    expect(readFileSync(join(target, 'requests', 'example.http'), 'utf-8')).toBe(
      'GET https://kept/hand-authored'
    )
  })

  it('uses the graphql starter when asked', async () => {
    const created = await initWorkspace({
      name: 'gql',
      cwd: tmp,
      template: 'graphql',
      write: () => {}
    })
    expect(readFileSync(join(created, 'requests', 'example.http'), 'utf-8')).toContain(
      'POST {{baseUrl}}/graphql'
    )
  })

  // Atomic writes — closing the write-safety coverage gap: `writeIfAbsent`
  // used to do a direct fs.writeFile with no temp file at all. Target only the
  // default-env-config rename — `createWorkspace`'s own (already-migrated)
  // seed writes rename first and would otherwise absorb a blanket mock.
  it('retries the rename through a transient error and still seeds the default env config (CA-06)', async () => {
    const realRename = fs.rename.bind(fs)
    let thrown = false
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes(join('default', 'config.json')) && !thrown) {
        thrown = true
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
      }
      return realRename(from, to)
    })

    const created = await initWorkspace({ name: 'retry-ws', cwd: tmp, write: () => {} })

    expect(thrown).toBe(true)
    renameSpy.mockRestore()
    const env = JSON.parse(
      readFileSync(join(created, 'environments', 'default', 'config.json'), 'utf-8')
    )
    expect(env.variables.baseUrl).toBe('https://example.com')
  })
})
