import { describe, it, expect } from 'vitest'
import { Command } from 'commander'
import { addRunOptions, MAX_TIMER_MS, toRunOptions } from './run-options'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

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
      delay: '100',
      timeout: '5000',
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

describe('toRunOptions — CI-safe flags', () => {
  it('defaults the per-request timeout to 30 s, like the desktop', () => {
    expect(toRunOptions([], {}).timeoutMs).toBe(30000)
  })

  it('--timeout 0 is the only way to disable the timeout', () => {
    expect(toRunOptions([], { timeout: '0' }).timeoutMs).toBe(0)
  })

  it('accepts the runtime timer maximum and refuses anything above it, naming the maximum', () => {
    expect(toRunOptions([], { timeout: String(MAX_TIMER_MS) }).timeoutMs).toBe(2147483647)
    let err: unknown
    try {
      toRunOptions([], { timeout: '2147483648' })
    } catch (e) {
      err = e
    }
    expect((err as CliError).exitCode).toBe(EXIT.USAGE)
    expect((err as CliError).message).toContain('2147483647')
    expect(() => toRunOptions([], { delay: '9999999999' })).toThrow(/--delay/)
  })

  it('--delay 0 means no wait', () => {
    expect(toRunOptions([], { delay: '0' }).delay).toBe(0)
  })

  it.each(['abc', '-1', '1.5', '', ' ', '1e3', '0x10', 'Infinity'])(
    'rejects --timeout %j as a usage error naming the flag and the value',
    (value) => {
      let err: unknown
      try {
        toRunOptions([], { timeout: value })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).exitCode).toBe(EXIT.USAGE)
      expect((err as CliError).message).toContain('--timeout')
      expect((err as CliError).message).toContain(JSON.stringify(value))
    }
  )

  it.each(['x', '-5', '2.5'])('rejects --delay %j as a usage error', (value) => {
    expect(() => toRunOptions([], { delay: value })).toThrow(/--delay/)
  })

  it('maps --persist-env', () => {
    expect(toRunOptions([], { persistEnv: true }).persistEnv).toBe(true)
    expect(toRunOptions([], {}).persistEnv).toBe(false)
  })

  it('passes --proxy and --no-proxy through', () => {
    expect(toRunOptions([], { proxyUrl: 'http://p:1', proxyGiven: true }).proxy).toBe('http://p:1')
    expect(toRunOptions([], { noProxyGiven: true }).noProxy).toBe(true)
  })

  it('rejects --proxy together with --no-proxy as a usage error', () => {
    let err: unknown
    try {
      toRunOptions([], { proxyUrl: 'http://p:1', proxyGiven: true, noProxyGiven: true })
    } catch (e) {
      err = e
    }
    expect((err as CliError).exitCode).toBe(EXIT.USAGE)
    expect((err as CliError).message).toMatch(/--proxy.*--no-proxy/)
  })
})

describe('addRunOptions — flag parsing', () => {
  const parse = (argv: string[]): ReturnType<typeof toRunOptions> => {
    const cmd = addRunOptions(new Command()).exitOverride()
    let captured: ReturnType<typeof toRunOptions> | undefined
    cmd.action((paths: string[], raw: Parameters<typeof toRunOptions>[1]) => {
      captured = toRunOptions(paths, raw)
    })
    cmd.parse(argv, { from: 'user' })
    return captured!
  }

  it('records --proxy and --no-proxy independently so a conflict is detectable', () => {
    expect(parse(['--proxy', 'http://p:1']).proxy).toBe('http://p:1')
    expect(parse(['--no-proxy']).noProxy).toBe(true)
    expect(() => parse(['--proxy', 'http://p:1', '--no-proxy'])).toThrow(CliError)
  })

  it('counts repeated -v', () => {
    expect(parse(['-vv']).verbosity).toBe(2)
    expect(parse(['-v', '-v', '-v']).verbosity).toBe(3)
  })

  it('passes --tls-config through as the path it names, and leaves it unset otherwise', () => {
    expect(parse(['--tls-config', 'local/tls.json']).tlsConfig).toBe('local/tls.json')
    expect(parse([])).not.toHaveProperty('tlsConfig')
  })
})
