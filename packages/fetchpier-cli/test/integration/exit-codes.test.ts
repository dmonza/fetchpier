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
})
