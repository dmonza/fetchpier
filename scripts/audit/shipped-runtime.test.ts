import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import {
  evaluateAudit,
  evaluateRuntimeCurrency,
  isRuntimeInAuditedTree,
  parseGraceDays,
  runShippedRuntimeAudit
  // @ts-expect-error — mjs with JSDoc types, no .d.ts emitted.
} from './shipped-runtime.mjs'

const NOW = new Date('2026-11-09T12:00:00.000Z')
const OLD = '2026-10-01T00:00:00.000Z'

function auditReport(vulnerabilities: Record<string, unknown> = {}): object {
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {} } }
}

function vulnerability(severity: string, url = 'https://example.test/advisory'): object {
  return { severity, via: [{ url, title: 'An advisory' }] }
}

describe('evaluateAudit', () => {
  it('passes a clean report', () => {
    expect(evaluateAudit(auditReport())).toEqual({ status: 'ok', findings: [] })
  })

  it.each(['moderate', 'high', 'critical'])('reports a %s advisory', (severity) => {
    const result = evaluateAudit(auditReport({ 'some-package': vulnerability(severity) }))
    expect(result.status).toBe('findings')
    expect(result.findings).toEqual([
      { name: 'some-package', severity, advisories: ['https://example.test/advisory'] }
    ])
  })

  it.each(['info', 'low'])('ignores a %s advisory, below the threshold', (severity) => {
    expect(evaluateAudit(auditReport({ pkg: vulnerability(severity) })).status).toBe('ok')
  })

  it('reports every offender, sorted by name, and tolerates transitive-only entries', () => {
    const result = evaluateAudit(
      auditReport({
        zeta: vulnerability('high'),
        alpha: { severity: 'moderate', via: ['zeta'] }
      })
    )
    expect(result.findings.map((f: { name: string }) => f.name)).toEqual(['alpha', 'zeta'])
    expect(result.findings[0].advisories).toEqual([])
  })

  it.each([
    ['an npm error payload', { error: { code: 'ENOTFOUND', summary: 'request failed' } }],
    ['a payload with no metadata', { vulnerabilities: {} }],
    ['null', null]
  ])('treats %s as unavailable, never as clean', (_label, report) => {
    expect(evaluateAudit(report).status).toBe('unavailable')
  })
})

describe('evaluateRuntimeCurrency', () => {
  const lines = {
    '45.2.0': OLD,
    '44.1.0': OLD,
    '43.8.9': OLD,
    '43.8.10': OLD,
    '42.3.0': OLD
  }

  function check(
    installed: string,
    times: Record<string, string> = lines
  ): {
    status: string
    message?: string
  } {
    return evaluateRuntimeCurrency({ installed, times, now: NOW })
  }

  it('passes the latest release of a supported line', () => {
    expect(check('45.2.0').status).toBe('ok')
  })

  it('accepts the oldest of the three supported lines', () => {
    expect(check('43.8.10').status).toBe('ok')
  })

  it('compares versions numerically, not as text', () => {
    const result = check('43.8.9')
    expect(result.status).toBe('behind')
    expect(result.message).toContain('43.8.9')
    expect(result.message).toContain('43.8.10')
  })

  it('rejects the fourth line even when it is the latest of its own line', () => {
    const result = check('42.3.0')
    expect(result.status).toBe('unsupported')
    expect(result.message).toContain('45, 44, 43')
  })

  it('ignores a newer prerelease', () => {
    expect(check('45.2.0', { ...lines, '46.0.0-beta.1': OLD, '45.3.0-alpha.2': OLD }).status).toBe(
      'ok'
    )
  })

  it('rejects an installed prerelease', () => {
    expect(check('46.0.0-beta.1', { ...lines, '46.0.0-beta.1': OLD }).status).toBe('unsupported')
  })

  describe('freshness window', () => {
    const exactlyTwoDays = '2026-11-07T12:00:00.000Z'
    const justUnderTwoDays = '2026-11-07T12:00:00.001Z'

    it('counts a release published exactly two days ago', () => {
      expect(check('45.2.0', { ...lines, '45.2.1': exactlyTwoDays }).status).toBe('behind')
    })

    it('does not demand a release younger than two days', () => {
      expect(check('45.2.0', { ...lines, '45.2.1': justUnderTwoDays }).status).toBe('ok')
    })

    it('passes when the installed version is itself younger than the window', () => {
      expect(check('45.2.1', { ...lines, '45.2.1': justUnderTwoDays }).status).toBe('ok')
    })

    it('does not retire a line because of a major younger than the window', () => {
      expect(check('43.8.10', { ...lines, '46.0.0': justUnderTwoDays }).status).toBe('ok')
    })

    it('retires the oldest line once the new major clears the window', () => {
      expect(check('43.8.10', { ...lines, '46.0.0': exactlyTwoDays }).status).toBe('unsupported')
    })
  })

  describe('grace period', () => {
    const daysAgo = (days: number, extraMs = 0): string =>
      new Date(NOW.getTime() - days * 86_400_000 - extraMs).toISOString()

    function tolerant(
      installed: string,
      times: Record<string, string>
    ): { status: string; message?: string } {
      return evaluateRuntimeCurrency({ installed, times, now: NOW, graceDays: 30 })
    }

    it('tolerates a patch available for exactly the grace period, and says so', () => {
      const result = tolerant('45.2.0', { ...lines, '45.2.1': daysAgo(30) })
      expect(result.status).toBe('lagging')
      expect(result.message).toContain('45.2.1')
      expect(result.message).toContain('30 days')
    })

    it('stops tolerating one millisecond past the grace period', () => {
      expect(tolerant('45.2.0', { ...lines, '45.2.1': daysAgo(30, 1) }).status).toBe('behind')
    })

    it('measures from the oldest missing patch, so a new patch does not restart the clock', () => {
      const result = tolerant('45.2.0', {
        ...lines,
        '45.2.1': daysAgo(40),
        '45.2.2': daysAgo(3)
      })
      expect(result.status).toBe('behind')
      expect(result.message).toContain('45.2.2')
    })

    it('reports a current runtime as current', () => {
      expect(tolerant('45.2.0', lines).status).toBe('ok')
    })

    it('tolerates a retired line within the grace period', () => {
      const result = tolerant('42.3.0', {
        ...lines,
        '45.0.0': daysAgo(20),
        '45.2.0': daysAgo(3)
      })
      expect(result.status).toBe('lagging')
      expect(result.message).toContain('45, 44, 43')
    })

    it('measures a retired line from the first release of the major that retired it', () => {
      expect(
        tolerant('42.3.0', { ...lines, '45.0.0': daysAgo(31), '45.2.0': daysAgo(3) }).status
      ).toBe('unsupported')
    })

    it('measures a line two majors out from the major that actually retired it', () => {
      expect(
        tolerant('41.0.0', { ...lines, '41.0.0': OLD, '45.0.0': daysAgo(5), '45.2.0': daysAgo(3) })
          .status
      ).toBe('unsupported')
    })

    it('gives no tolerance to an installed prerelease', () => {
      expect(tolerant('46.0.0-beta.1', { ...lines, '46.0.0-beta.1': OLD }).status).toBe(
        'unsupported'
      )
    })

    it('is strict when no grace period is given', () => {
      expect(check('45.2.0', { ...lines, '45.2.1': daysAgo(3) }).status).toBe('behind')
    })
  })

  it('ignores the non-version keys of the registry time map', () => {
    expect(check('45.2.0', { ...lines, created: OLD, modified: OLD }).status).toBe('ok')
  })

  it.each([
    ['an empty map', {}],
    ['only non-version keys', { created: OLD, modified: OLD }],
    ['unparseable dates', { '45.2.0': 'not-a-date' }]
  ])('treats %s as unavailable', (_label, times) => {
    expect(check('45.2.0', times as Record<string, string>).status).toBe('unavailable')
  })
})

describe('isRuntimeInAuditedTree', () => {
  it('finds the runtime nested under a runtime dependency', () => {
    expect(
      isRuntimeInAuditedTree({
        dependencies: { '@some/toolkit': { dependencies: { electron: { version: '1.0.0' } } } }
      })
    ).toBe(true)
  })

  it('finds the runtime at the top level', () => {
    expect(isRuntimeInAuditedTree({ dependencies: { electron: { version: '1.0.0' } } })).toBe(true)
  })

  it.each([
    ['an empty tree', {}],
    ['a tree without the runtime', { dependencies: { other: { version: '1.0.0' } } }],
    ['null', null]
  ])('is false for %s', (_label, tree) => {
    expect(isRuntimeInAuditedTree(tree)).toBe(false)
  })
})

describe('runShippedRuntimeAudit', () => {
  const healthy: Record<string, string> = {
    audit: JSON.stringify(auditReport()),
    ls: JSON.stringify({ dependencies: { electron: { version: '45.2.0' } } }),
    view: JSON.stringify({ '45.2.0': OLD })
  }

  function run(
    outputs: Partial<Record<string, string>>,
    installed: string | undefined = '45.2.0',
    graceDays = 0
  ): { ok: boolean; failures: { kind: string; message: string }[]; notices: string[] } {
    const merged = { ...healthy, ...outputs }
    return runShippedRuntimeAudit({
      runNpm: (args: string[]) => {
        const command = args[0]
        return { stdout: merged[command] ?? '' }
      },
      readInstalledVersion: () => installed,
      graceDays,
      now: NOW
    })
  }

  it('passes when every check passes', () => {
    expect(run({})).toEqual({ ok: true, failures: [], notices: [] })
  })

  it('names the package and advisory of a finding', () => {
    const { ok, failures } = run({
      audit: JSON.stringify(auditReport({ 'bad-pkg': vulnerability('moderate') }))
    })
    expect(ok).toBe(false)
    expect(failures[0].kind).toBe('finding')
    expect(failures[0].message).toContain('bad-pkg')
    expect(failures[0].message).toContain('https://example.test/advisory')
  })

  it('fails when the runtime has left the audited tree', () => {
    const { failures } = run({ ls: JSON.stringify({ dependencies: {} }) })
    expect(failures.map((f) => f.kind)).toEqual(['not-audited'])
  })

  it('reports every failing check, not only the first', () => {
    const { failures } = run({
      audit: JSON.stringify(auditReport({ 'bad-pkg': vulnerability('high') })),
      view: JSON.stringify({ '45.2.1': OLD, '45.2.0': OLD })
    })
    expect(failures.map((f) => f.kind)).toEqual(['finding', 'behind'])
  })

  it.each([
    ['audit', 'not json'],
    ['audit', ''],
    ['view', 'not json'],
    ['view', '']
  ])('reports unreachable data distinctly when %s returns %j', (command, stdout) => {
    const { ok, failures } = run({ [command]: stdout })
    expect(ok).toBe(false)
    expect(failures[0].kind).toBe('unavailable')
    expect(failures[0].message).toMatch(/could not/i)
  })

  it('reports unreachable data distinctly when the tree listing is unreadable', () => {
    expect(run({ ls: 'not json' }).failures[0].kind).toBe('unavailable')
  })

  describe('with a grace period', () => {
    const behind = JSON.stringify({ '45.2.1': '2026-11-01T00:00:00.000Z', '45.2.0': OLD })

    it('passes tolerated lag and reports it as a notice', () => {
      const { ok, failures, notices } = run({ view: behind }, '45.2.0', 30)
      expect(ok).toBe(true)
      expect(failures).toEqual([])
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain('45.2.1')
    })

    it('fails the same lag without one', () => {
      expect(run({ view: behind }).failures.map((f) => f.kind)).toEqual(['behind'])
    })

    it('never tolerates an advisory', () => {
      const { ok, failures } = run(
        {
          audit: JSON.stringify(auditReport({ 'bad-pkg': vulnerability('moderate') })),
          view: behind
        },
        '45.2.0',
        30
      )
      expect(ok).toBe(false)
      expect(failures.map((f) => f.kind)).toEqual(['finding'])
    })

    it('never tolerates unreadable data', () => {
      const { ok, failures } = run({ view: 'not json' }, '45.2.0', 30)
      expect(ok).toBe(false)
      expect(failures[0].kind).toBe('unavailable')
    })
  })

  it('fails when the lockfile does not name the runtime', () => {
    const result = runShippedRuntimeAudit({
      runNpm: (args: string[]) => ({ stdout: healthy[args[0]] }),
      readInstalledVersion: () => undefined,
      now: NOW
    })
    expect(result.failures[0].kind).toBe('unavailable')
  })
})

describe('parseGraceDays', () => {
  it('defaults to no grace period', () => {
    expect(parseGraceDays([])).toBe(0)
  })

  it('reads the flag', () => {
    expect(parseGraceDays(['--grace-days=30'])).toBe(30)
  })

  it.each([
    '--grace-days=abc',
    '--grace-days=-1',
    '--grace-days=',
    '--grace-days',
    '--grace-days=1.5'
  ])('rejects %s rather than running without the intended policy', (flag) => {
    expect(() => parseGraceDays([flag])).toThrow(/grace-days/)
  })
})

// CI-009
describe('the gates share one definition', () => {
  const root = resolve(__dirname, '..', '..')
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf-8')

  it('exposes the check as one npm script', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    expect(scripts['audit:shipped']).toBe('node scripts/audit/shipped-runtime.mjs')
  })

  it('runs it from preflight, with no separate audit call', () => {
    const preflight = read('scripts/preflight.mjs')
    expect(preflight).toMatch(/\['run', 'audit:shipped'\]/)
    expect(preflight).not.toMatch(/\['audit',/)
    expect(preflight).not.toMatch(/grace-days/)
  })

  it('runs it from the nightly audit job, with no separate audit call', () => {
    interface Step {
      run?: string
    }
    const nightly = yaml.load(read('.github/workflows/nightly.yml')) as {
      jobs: Record<string, { steps: Step[] }>
    }
    const runs = nightly.jobs.audit.steps.map((step) => step.run ?? '')
    expect(runs).toContain('npm run audit:shipped -- --grace-days=30')
    expect(runs.some((run) => /\bnpm audit\b/.test(run))).toBe(false)
  })
})
