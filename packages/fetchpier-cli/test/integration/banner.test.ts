/**
 * Identity banner. `fp --version` and a bare `fp` announce the product; every
 * other invocation stays silent, because stdout belongs to the reporters — a
 * banner there would break a JSON report piped into a CI step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLocal, type Mockttp } from 'mockttp'
import { COPYRIGHT_LINE } from '../../src/banner'
import { CLI_VERSION } from '../../src/version'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '../..')
const BIN = resolve(PACKAGE_ROOT, 'dist/fp.js')

const BANNER = `Fetchpier ${CLI_VERSION}\n${COPYRIGHT_LINE}`

let server: Mockttp
let ws: string

beforeAll(async () => {
  // Built by the `cli` project's globalSetup, not here: a per-spec build races
  // the other specs' builds and blows the 10 s hook budget (see that file).
  if (!existsSync(BIN)) {
    throw new Error(
      `[cli] CLI bundle missing: ${BIN}\n` +
        `Run the suite via \`npm test\` / \`npm run test:cli\` so globalSetup builds it.`
    )
  }
  server = getLocal()
  await server.start()
  await server.forGet('/ok').thenJson(200, { ok: true })

  ws = mkdtempSync(join(tmpdir(), 'fp-banner-'))
  mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  writeFileSync(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  const envDir = join(ws, 'environments', 'default')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(
    join(envDir, 'config.json'),
    JSON.stringify({ id: 'default', name: 'default', variables: { baseUrl: server.url } })
  )
  mkdirSync(join(ws, 'requests'), { recursive: true })
  writeFileSync(join(ws, 'requests', 'ok.http'), 'GET {{baseUrl}}/ok\n')
}, 120000)

afterAll(async () => {
  await server.stop()
})

interface Run {
  status: number
  stdout: string
  stderr: string
}

/**
 * Spawn asynchronously, never `spawnSync`: the mock server lives in this same
 * process, so a blocking spawn would deadlock any `fp run` waiting on it.
 */
function fp(args: string[]): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ws })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')))
    child.on('error', reject)
    child.on('close', (status) => resolvePromise({ status: status ?? -1, stdout, stderr }))
  })
}

describe('fp --version', () => {
  it.each(['--version', '-V'])(
    '%s prints the banner to stdout and exits 0',
    async (flag) => {
      const { status, stdout, stderr } = await fp([flag])
      expect(status).toBe(0)
      expect(stdout).toBe(`${BANNER}\n`)
      expect(stderr).toBe('')
    },
    30000
  )
})

describe('fp with no arguments', () => {
  it('prints the banner above the usage text on stderr, keeping stdout empty', async () => {
    const { status, stdout, stderr } = await fp([])
    expect(status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr.startsWith(BANNER)).toBe(true)
    expect(stderr).toContain('Usage: fp')
  }, 30000)
})

describe('no banner anywhere else', () => {
  it('fp --help stays banner-free', async () => {
    const { stdout, stderr } = await fp(['--help'])
    expect(stdout).toContain('Usage: fp')
    expect(stdout).not.toContain(COPYRIGHT_LINE)
    expect(stderr).not.toContain(COPYRIGHT_LINE)
  }, 30000)

  it('a normal command prints no banner', async () => {
    const { status, stdout } = await fp(['env', 'list', '--workspace', ws])
    expect(status).toBe(0)
    expect(stdout).not.toContain(COPYRIGHT_LINE)
    expect(stdout).not.toContain('Fetchpier ')
  }, 30000)

  it('a JSON report on stdout parses, with no banner around it', async () => {
    const { stdout } = await fp([
      'run',
      join(ws, 'requests', 'ok.http'),
      '--workspace',
      ws,
      '--reporter-json',
      '-'
    ])
    expect(stdout).not.toContain(COPYRIGHT_LINE)
    const report = JSON.parse(stdout) as { fetchpier: { cliVersion: string } }
    expect(report.fetchpier.cliVersion).toBe(CLI_VERSION)
  }, 60000)
})
