/**
 * REQ-0115 — the CLI reports a cookie the jar refused (COOKIE-005).
 *
 * A rejection says something about the *response*, not about the run, so it must
 * not move the exit code: a CI pipeline that starts failing because a server
 * emitted a badly-scoped cookie would be worse than the silence it replaced.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLocal, type Mockttp } from 'mockttp'
import { executeRun } from '../../src/commands/request/run'

let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const workspaces: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await server.reset()
  for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true })
})

function buildWorkspace(url: string): string {
  const ws = mkdtempSync(join(tmpdir(), 'fp-cookie-warn-'))
  workspaces.push(ws)
  mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  writeFileSync(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  const envDir = join(ws, 'environments', 'dev')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(
    join(envDir, 'config.json'),
    JSON.stringify({ id: 'dev', name: 'dev', variables: {} })
  )
  mkdirSync(join(ws, 'requests'), { recursive: true })
  writeFileSync(join(ws, 'requests', 'evil.http'), `GET ${url}/evil\n`)
  return ws
}

describe('COOKIE-005 — a refused cookie is reported without failing the run', () => {
  it('warns on stderr and leaves the exit-relevant counters untouched', async () => {
    await server
      .forGet('/evil')
      .thenReply(200, 'ok', { 'set-cookie': 'sid=1; Domain=unrelated.test' })
    const ws = buildWorkspace(server.url)
    const warnings: string[] = []

    const summary = await executeRun(
      { workspace: ws, environment: 'dev', paths: ['requests/evil.http'] },
      {
        cwd: ws,
        env: {} as NodeJS.ProcessEnv,
        reporterContext: { write: () => {}, writeErr: (s: string) => warnings.push(s) }
      }
    )

    expect(summary.summary.requests.failed).toBe(0)
    expect(summary.summary.requests.passed).toBe(1)
    expect(warnings.join('\n')).toContain('was rejected')
    expect(warnings.join('\n')).toContain('sid')
  })

  it('carries the structured code into the machine-readable report', async () => {
    // A pipeline must be able to match on the code rather than on the prose,
    // which is free to change. Before REQ-0115 the JSON reporter dropped every
    // warning, so there was nothing to match on at all.
    await server
      .forGet('/evil')
      .thenReply(200, 'ok', { 'set-cookie': 'sid=1; Domain=unrelated.test' })
    const ws = buildWorkspace(server.url)
    const reportPath = join(ws, 'report.json')

    await executeRun(
      {
        workspace: ws,
        environment: 'dev',
        paths: ['requests/evil.http'],
        reporters: [{ type: 'json', output: reportPath }]
      },
      {
        cwd: ws,
        env: {} as NodeJS.ProcessEnv,
        reporterContext: { write: () => {}, writeErr: () => {} }
      }
    )

    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      warnings?: { message: string; detail?: { code: string; reason?: string } }[]
    }
    expect(report.warnings).toBeDefined()
    expect(report.warnings![0].detail).toMatchObject({
      code: 'COOKIE_REJECTED',
      reason: 'DOMAIN_MISMATCH'
    })
  })
})
