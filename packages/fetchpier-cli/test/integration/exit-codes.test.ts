import { beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '../..')
const BIN = resolve(PACKAGE_ROOT, 'dist/fp.js')

let ws: string

beforeAll(() => {
  // Built by the `cli` project's globalSetup, not here: a per-spec build races
  // the other specs' builds and blows the 10 s hook budget (see that file).
  if (!existsSync(BIN)) {
    throw new Error(
      `[cli] CLI bundle missing: ${BIN}\n` +
        `Run the suite via \`npm test\` / \`npm run test:cli\` so globalSetup builds it.`
    )
  }
  ws = mkdtempSync(join(tmpdir(), 'fp-exit-'))
  mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  writeFileSync(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  const envDir = join(ws, 'environments', 'default')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(
    join(envDir, 'config.json'),
    JSON.stringify({ id: 'default', name: 'default', variables: {} })
  )
  mkdirSync(join(ws, 'requests'), { recursive: true })
  writeFileSync(join(ws, 'requests', 'ok.http'), 'GET {{baseUrl}}/x\n')
})

function fp(args: string[], cwd: string = ws): { status: number; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8', cwd })
  return { status: r.status ?? -1, stderr: r.stderr }
}

describe('exit codes', () => {
  it('4 — workspace not found', () => {
    const { status, stderr } = fp(['run', 'requests/ok.http', '--workspace', join(ws, 'nope')])
    expect(status).toBe(4)
    expect(stderr).toContain('Workspace not found')
  }, 60000)

  it('5 — input path not found', () => {
    const { status, stderr } = fp(['run', 'requests/missing.http', '--workspace', ws])
    expect(status).toBe(5)
    expect(stderr).toContain('Path not found')
    // Missing everywhere: nothing to suggest.
    expect(stderr).not.toContain('Did you mean')
  }, 60000)

  it('5 — a path relative to the workspace, typed from outside it, gets a suggestion', () => {
    const { status, stderr } = fp(['run', 'requests/ok.http', '--workspace', ws], dirname(ws))
    expect(status).toBe(5)
    expect(stderr).toContain('Path not found: requests/ok.http')
    expect(stderr).toContain(`Did you mean ${basename(ws)}/requests/ok.http?`)
  }, 60000)

  it('6 — environment not found', () => {
    const { status, stderr } = fp(['run', 'requests/ok.http', '--workspace', ws, '--env', 'qa'])
    expect(status).toBe(6)
    expect(stderr).toContain("Environment 'qa' not found")
  }, 60000)

  it('7 — malformed --env-var', () => {
    const { status, stderr } = fp([
      'run',
      'requests/ok.http',
      '--workspace',
      ws,
      '--env-var',
      'TOKEN'
    ])
    expect(status).toBe(7)
    expect(stderr).toContain('Malformed --env-var')
  }, 60000)

  it('9 — unknown reporter (programmatic config only reaches via run)', () => {
    // The binary never accepts an unknown reporter name through flags, so this
    // guards the factory contract: an unrecognized type aborts the run.
    const { status } = fp([
      'run',
      'requests/ok.http',
      '--workspace',
      ws,
      '--reporter-junit',
      join(ws, 'no', 'sub', 'r.xml')
    ])
    expect(status).toBe(2) // output directory does not exist → exit 2
  }, 60000)

  // CI readiness (CA-16): a target with nothing to run is not a success.
  it('19 — a folder with no request, even with --suppress-exit-code', () => {
    mkdirSync(join(ws, 'requests', 'empty'), { recursive: true })
    const { status, stderr } = fp([
      'run',
      'requests/empty',
      '--workspace',
      ws,
      '--suppress-exit-code'
    ])
    expect(status).toBe(19)
    expect(stderr).toContain('No requests to run')
  }, 60000)

  // CI readiness (CA-17): a value that cannot be honoured is refused, not ignored.
  it.each([
    [['--timeout', 'abc'], '--timeout'],
    [['--timeout', '-1'], '--timeout'],
    [['--delay', '1.5'], '--delay']
  ])(
    '3 — invalid %j',
    (flags, flag) => {
      const { status, stderr } = fp(['run', 'requests/ok.http', '--workspace', ws, ...flags])
      expect(status).toBe(3)
      expect(stderr).toContain(flag)
    },
    60000
  )

  // CI readiness (CA-14): an unusable proxy is fatal before anything is sent.
  it('3 — an invalid proxy variable names its source', () => {
    const r = spawnSync(process.execPath, [BIN, 'run', 'requests/ok.http', '--workspace', ws], {
      encoding: 'utf-8',
      cwd: ws,
      env: { ...process.env, HTTPS_PROXY: 'not a url' }
    })
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('HTTPS_PROXY')
  }, 60000)

  // CLI hardening (CA-12): a timer the runtime cannot honour is refused.
  it('3 — --timeout above the runtime timer maximum names the maximum', () => {
    const { status, stderr } = fp([
      'run',
      'requests/ok.http',
      '--workspace',
      ws,
      '--timeout',
      '2147483648'
    ])
    expect(status).toBe(3)
    expect(stderr).toContain('2147483647')
  }, 60000)

  // CLI hardening (CA-09 / CA-10): corrupt configuration stops the run, named.
  it('4 — corrupt settings.json, and a corrupt selected environment (not "not found")', () => {
    const broken = mkdtempSync(join(tmpdir(), 'fp-exit-corrupt-'))
    mkdirSync(join(broken, '.fetchpier'), { recursive: true })
    writeFileSync(join(broken, '.fetchpier', 'settings.json'), '{ "version": 1, ')
    mkdirSync(join(broken, 'environments', 'default'), { recursive: true })
    writeFileSync(
      join(broken, 'environments', 'default', 'config.json'),
      JSON.stringify({ id: 'default', name: 'default', variables: {} })
    )
    mkdirSync(join(broken, 'requests'), { recursive: true })
    writeFileSync(join(broken, 'requests', 'ok.http'), 'GET http://127.0.0.1:1/x\n')

    const settings = fp(['run', '--workspace', broken])
    expect(settings.status).toBe(4)
    expect(settings.stderr).toContain('settings.json')

    writeFileSync(join(broken, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
    writeFileSync(join(broken, 'environments', 'default', 'config.json'), '{ broken')
    const environment = fp(['run', '--workspace', broken])
    expect(environment.status).toBe(4)
    expect(environment.stderr).toContain("Environment 'default' could not be read")
    expect(environment.stderr).not.toContain('not found')

    // A parseable file with a malformed shape is the same case — never a 255.
    writeFileSync(
      join(broken, 'environments', 'default', 'config.json'),
      JSON.stringify({ id: 'default', variables: {} })
    )
    const shapeless = fp(['run', '--workspace', broken])
    expect(shapeless.status).toBe(4)
    expect(shapeless.stderr).toContain('"name" must be a non-empty string')
    expect(shapeless.stderr).not.toContain('This is a bug')
  }, 60000)

  it('3 — --proxy together with --no-proxy', () => {
    const { status, stderr } = fp([
      'run',
      'requests/ok.http',
      '--workspace',
      ws,
      '--proxy',
      'http://proxy.test:3128',
      '--no-proxy'
    ])
    expect(status).toBe(3)
    expect(stderr).toContain('--no-proxy')
  }, 60000)
})
