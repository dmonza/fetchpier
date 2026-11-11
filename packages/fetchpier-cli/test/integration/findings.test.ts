/**
 * Passive security findings on the command line (FIND-008..011, FIND-015).
 *
 * `--findings` adds findings to the terminal, JSON and HTML reports and changes
 * nothing else: not the exit-relevant counters, not JUnit, not the JSON schema
 * version. The workspace's `enabled` governs the desktop only; the rule set
 * (disabled rules, expiry window) applies here too.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp'
import { requests, workspace as coreWorkspace } from '@fetchpier/core'
import { executeRun } from '../../src/commands/request/run'
import type { RequestUnit, RunOptions, RunSummary } from '../../src/types'

let tlsServer: Mockttp
let plainServer: Mockttp

beforeAll(async () => {
  const ca = await generateCACertificate({ subject: { commonName: 'localhost' } })
  tlsServer = getLocal({ https: { key: ca.key, cert: ca.cert } })
  plainServer = getLocal()
  await Promise.all([tlsServer.start(), plainServer.start()])
}, 60_000)

afterAll(async () => {
  await Promise.all([tlsServer.stop(), plainServer.stop()])
})

const workspaces: string[] = []
afterEach(async () => {
  await Promise.all([tlsServer.reset(), plainServer.reset()])
  for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true })
})

function buildWorkspace(files: Record<string, string>, http?: Record<string, unknown>): string {
  const ws = mkdtempSync(join(tmpdir(), 'fp-findings-'))
  workspaces.push(ws)
  mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  writeFileSync(
    join(ws, '.fetchpier', 'settings.json'),
    JSON.stringify(http ? { version: 1, http } : { version: 1 })
  )
  const envDir = join(ws, 'environments', 'dev')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(
    join(envDir, 'config.json'),
    JSON.stringify({ id: 'dev', name: 'dev', variables: {} })
  )
  mkdirSync(join(ws, 'requests'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(ws, 'requests', name), content)
  }
  return ws
}

interface Captured {
  summary: RunSummary
  out: string
  err: string
}

async function run(ws: string, options: Partial<RunOptions>): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const summary = await executeRun(
    { workspace: ws, environment: 'dev', paths: [], ...options },
    {
      cwd: ws,
      env: {} as NodeJS.ProcessEnv,
      reporterContext: { write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) }
    }
  )
  return { summary, out: out.join(''), err: err.join('') }
}

const unitFindings = (u: RequestUnit) => {
  if (!u.findings || 'evaluationFailed' in u.findings) throw new Error('not evaluated')
  return u.findings
}

describe('FIND-009 — --findings reports in the terminal, JSON and HTML, and nothing else changes', () => {
  it('adds findings to every report but JUnit, keeps schema 1.0 and the counters', async () => {
    await tlsServer.forGet('/api').thenReply(200, 'ok', { 'content-type': 'text/plain' })
    const ws = buildWorkspace({ 'api.http': `GET ${tlsServer.urlFor('/api')}\n` })
    const json = join(ws, 'out.json')
    const html = join(ws, 'out.html')
    const xml = join(ws, 'out.xml')

    const { summary, out } = await run(ws, {
      findings: true,
      insecure: true,
      reporters: [
        { type: 'cli' },
        { type: 'json', output: json },
        { type: 'html', output: html },
        { type: 'junit', output: xml }
      ]
    })

    expect(out).toContain('Security findings')
    expect(out).toContain('Server certificate is not trusted')

    const report = JSON.parse(readFileSync(json, 'utf-8')) as RunSummary
    expect(report.schemaVersion).toBe('1.0')
    const f = unitFindings(report.units[0])
    expect(f.tls).toBe('captured')
    expect(f.items.find((i) => i.ruleId === 'tls.untrusted-certificate')).toMatchObject({
      severity: 'high',
      category: 'tls',
      // The local server's leaf is issued by its own CA.
      evidence: { error: 'SELF_SIGNED_CERT_IN_CHAIN' },
      title: 'Server certificate is not trusted'
    })
    expect(report.findingsSummary?.bySeverity.high).toBeGreaterThanOrEqual(1)
    expect(report.findingsSummary?.unitsWithFindings).toBe(1)

    expect(readFileSync(html, 'utf-8')).toContain('Server certificate is not trusted')
    const junit = readFileSync(xml, 'utf-8')
    expect(junit).not.toMatch(/findings|untrusted-certificate|tls\./)

    expect(summary.summary.requests).toEqual({ total: 1, passed: 1, failed: 0 })
  })

  it('says how many rules were applied when nothing fired, without a verdict', async () => {
    await plainServer.forGet('/ping').thenReply(204, '')
    const ws = buildWorkspace({ 'ping.http': `GET ${plainServer.urlFor('/ping')}\n` })
    const { out } = await run(ws, { findings: true })
    expect(out).toMatch(/No findings from the rules applied \(\d+\)\./)
    expect(out).not.toMatch(/\b(secure|safe|passed)\b/)
  })
})

describe('FIND-015 — without --findings the output is unchanged', () => {
  it('carries no findings field, line or advisory', async () => {
    await tlsServer.forGet('/api').thenReply(200, 'ok', { server: 'nginx/1.25.3' })
    const ws = buildWorkspace(
      { 'api.http': `GET ${tlsServer.urlFor('/api')}\n` },
      { findings: { disabledRules: ['no.such-rule'] } }
    )
    const json = join(ws, 'out.json')
    const { out, err } = await run(ws, {
      insecure: true,
      reporters: [{ type: 'cli' }, { type: 'json', output: json }]
    })
    const report = JSON.parse(readFileSync(json, 'utf-8')) as RunSummary & { warnings?: unknown[] }
    expect(report.units[0].findings).toBeUndefined()
    expect(report.findingsSummary).toBeUndefined()
    expect(JSON.stringify(report.warnings ?? [])).not.toContain('FINDINGS_')
    expect(out).not.toContain('Security findings')
    expect(err).not.toContain('findings')
  })
})

describe('FIND-010 — --findings wins over the workspace’s enabled; the rule set applies', () => {
  it('evaluates with enabled:false, honoring disabledRules', async () => {
    await plainServer
      .forGet('/v')
      .thenReply(200, 'body', { server: 'nginx/1.25.3', 'content-type': 'text/plain' })
    const ws = buildWorkspace(
      { 'v.http': `GET ${plainServer.urlFor('/v')}\n` },
      { findings: { enabled: false, disabledRules: ['headers.version-disclosure'] } }
    )
    const json = join(ws, 'out.json')
    const { out } = await run(ws, {
      findings: true,
      reporters: [{ type: 'cli' }, { type: 'json', output: json }]
    })
    const report = JSON.parse(readFileSync(json, 'utf-8')) as RunSummary
    const ids = unitFindings(report.units[0]).items.map((i) => i.ruleId)
    expect(ids).toContain('headers.nosniff-missing')
    expect(ids).not.toContain('headers.version-disclosure')
    expect(out).not.toMatch(/turned off/i)
  })
})

describe('FIND-011 — configuration advisories, once per run, with their codes', () => {
  it('reports an unknown rule id and an invalid field once across several requests', async () => {
    await plainServer.forGet('/a').thenReply(204, '')
    await plainServer.forGet('/b').thenReply(204, '')
    const ws = buildWorkspace(
      {
        'a.http': `GET ${plainServer.urlFor('/a')}\n`,
        'b.http': `GET ${plainServer.urlFor('/b')}\n`
      },
      { findings: { disabledRules: ['no.such-rule'], certExpiryWarnDays: -1 } }
    )
    const json = join(ws, 'out.json')
    await run(ws, { findings: true, reporters: [{ type: 'json', output: json }] })
    const report = JSON.parse(readFileSync(json, 'utf-8')) as {
      warnings?: { message: string; detail?: { code: string; ruleId?: string; field?: string } }[]
    }
    const codes = (report.warnings ?? []).map((w) => w.detail)
    expect(codes.filter((d) => d?.code === 'FINDINGS_RULE_UNKNOWN')).toEqual([
      { code: 'FINDINGS_RULE_UNKNOWN', ruleId: 'no.such-rule' }
    ])
    expect(codes.filter((d) => d?.code === 'FINDINGS_SETTING_INVALID')).toEqual([
      { code: 'FINDINGS_SETTING_INVALID', field: 'certExpiryWarnDays' }
    ])
    // The advisory names the field, never quotes the value.
    expect((report.warnings ?? []).map((w) => w.message).join('\n')).not.toMatch(/-1\b/)
  })
})

describe('FIND-008 — the command line reports what the engine evaluates', () => {
  it('matches a direct engine evaluation of the same exchange', async () => {
    await tlsServer.forGet('/p').thenReply(200, 'ok', { server: 'nginx/1.25.3' })
    const ws = buildWorkspace({ 'p.http': `GET ${tlsServer.urlFor('/p')}\n` })
    const json = join(ws, 'out.json')
    await run(ws, { findings: true, insecure: true, reporters: [{ type: 'json', output: json }] })
    const report = JSON.parse(readFileSync(json, 'utf-8')) as RunSummary
    const viaCli = unitFindings(report.units[0])

    const settings = await coreWorkspace.openWorkspace(ws).settings.loadStrict()
    const direct = await requests.execute(
      { method: 'GET', url: tlsServer.urlFor('/p'), headers: {} },
      {
        environmentId: null,
        workspaceSettings: { ...settings, verifySsl: false },
        userAgent: 'test',
        evaluateFindings: true
      }
    )
    if (direct.findings?.status !== 'evaluated') throw new Error('not evaluated')
    expect(viaCli.items.map(({ title: _t, ...rest }) => rest)).toEqual(direct.findings.items)
    expect(viaCli.rulesApplied).toBe(direct.findings.rulesApplied)
    expect(viaCli.tls).toBe(direct.findings.tls)
    expect(viaCli.finalOrigin).toBe(direct.findings.finalOrigin)
  })
})
