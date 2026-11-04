import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  promises as fs
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLocal, type Mockttp } from 'mockttp'
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

  // CLI-014 (hint variants): the follow-up command is one line that works from
  // the directory `init` ran in.
  it.each([
    ['my-api', 'fp run --workspace my-api'],
    ['my api', 'fp run --workspace "my api"'],
    [undefined, 'fp run']
  ])('hints a runnable next command for name %s', async (name, expected) => {
    const cwd = name ? tmp : join(tmp, 'here')
    if (!name) mkdirSync(cwd)
    let out = ''
    await initWorkspace({ name, cwd, write: (s) => (out += s) })
    expect(out).toContain(`\n  Next: ${expected}\n`)
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

// CLI-096 — the hint `fp init` prints, run verbatim through a shell from the
// directory `init` ran in, executes the starter request. The seeded base URL is
// re-pointed at a local mock (the hint itself is never edited). Spawned
// asynchronously: the mock lives in this process, so `spawnSync` would deadlock.
describe('fp init hint through the binary (CLI-096)', () => {
  const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/fp.js')
  let server: Mockttp
  let tmp: string

  beforeAll(async () => {
    if (!existsSync(BIN)) throw new Error(`[cli] CLI bundle missing: ${BIN}`)
    server = getLocal()
    await server.start()
  })
  afterAll(async () => {
    await server.stop()
  })
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fp-init-hint-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function sh(command: string, cwd: string): Promise<{ status: number; output: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, { cwd, shell: true })
      let output = ''
      child.stdout.on('data', (c: Buffer) => (output += c.toString('utf-8')))
      child.stderr.on('data', (c: Buffer) => (output += c.toString('utf-8')))
      child.on('error', reject)
      child.on('close', (status) => resolvePromise({ status: status ?? -1, output }))
    })
  }

  it('prints a next command that runs the starter request as written', async () => {
    const health = await server.forGet('/health').thenReply(200, 'ok')
    const fpCmd = `"${process.execPath}" "${BIN}"`

    const init = await sh(`${fpCmd} init my-api`, tmp)
    expect(init.status).toBe(0)
    const hint = /Next: (.+)$/m.exec(init.output)?.[1]?.trim()
    expect(hint).toMatch(/^fp /)

    const envFile = join(tmp, 'my-api', 'environments', 'default', 'config.json')
    const env = JSON.parse(readFileSync(envFile, 'utf-8'))
    env.variables.baseUrl = server.url
    writeFileSync(envFile, JSON.stringify(env))

    const run = await sh(`${fpCmd}${hint!.slice('fp'.length)}`, tmp)
    expect(run.status, run.output).toBe(0)
    expect(await health.getSeenRequests()).toHaveLength(1)
  }, 60000)
})
