import { describe, it, expect } from 'vitest'
import { toRunOptions } from './run-options'

describe('toRunOptions', () => {
  it('always includes the CLI reporter and appends file reporters', () => {
    const opts = toRunOptions(['a.http'], {
      reporterJson: 'out.json',
      reporterJsonNoBody: true,
      reporterJunit: 'out.xml',
      reporterHtml: 'out.html'
    })
    expect(opts.reporters).toEqual([
      { type: 'cli' },
      { type: 'json', output: 'out.json', options: { noBody: true } },
      { type: 'junit', output: 'out.xml' },
      { type: 'html', output: 'out.html', options: { onlyFailures: false } }
    ])
  })

  it('passes the HTML failures filter through when the flag is given', () => {
    const opts = toRunOptions([], { reporterHtml: 'out.html', reporterHtmlOnlyFailures: true })
    expect(opts.reporters).toContainEqual({
      type: 'html',
      output: 'out.html',
      options: { onlyFailures: true }
    })
  })

  it('supports json output to stdout via "-"', () => {
    const opts = toRunOptions([], { reporterJson: '-' })
    expect(opts.reporters).toContainEqual({ type: 'json', output: '-', options: { noBody: false } })
  })

  it('clamps verbosity at 3 and maps --no-color', () => {
    const opts = toRunOptions([], { verbose: 9, color: false })
    expect(opts.verbosity).toBe(3)
    expect(opts.noColor).toBe(true)
  })

  it('parses --env-var pairs', () => {
    const opts = toRunOptions([], { envVar: ['a=1', 'b=2'] })
    expect(opts.envVars).toEqual({ a: '1', b: '2' })
  })

  it('passes through paths and scalar flags', () => {
    const opts = toRunOptions(['x.http', 'y'], {
      workspace: '/ws',
      env: 'staging',
      bail: true,
      delay: 100,
      timeout: 5000,
      insecure: true,
      saveHistory: true,
      suppressExitCode: true,
      showSecrets: true,
      ascii: true,
      silent: true
    })
    expect(opts).toMatchObject({
      paths: ['x.http', 'y'],
      workspace: '/ws',
      environment: 'staging',
      bail: true,
      delay: 100,
      timeoutMs: 5000,
      insecure: true,
      saveHistory: true,
      suppressExitCode: true,
      showSecrets: true,
      ascii: true,
      silent: true
    })
  })
})
