import { Command, Option } from 'commander'
import { parseEnvVars } from '../context/parse-env-vars'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'
import type { ReporterConfig, RunOptions, Verbosity } from '../types'

/** Per-request timeout when `--timeout` is not given — the desktop's default (30 s). */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The largest delay the runtime's timers honour (2³¹ − 1 ms, ~24.8 days). A
 * larger one is not an error for the runtime — it fires after 1 ms — so it is
 * refused here instead of silently failing every request.
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Attach every `fp run` flag to a commander command. Shared by the canonical
 * `fp request run` and the top-level `fp run` alias so they stay byte-identical.
 */
export function addRunOptions(cmd: Command): Command {
  cmd
    .argument('[paths...]', 'one or more .http files or folders (default: the workspace requests/)')
    .option('-w, --workspace <path>', 'workspace folder (default: discovered from cwd)')
    .option('-e, --env <name>', 'environment folder name (default: FETCHPIER_ENV or "default")')
    .option(
      '--env-var <pair>',
      'override a variable as KEY=VALUE (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option(
      '--persist-env',
      'persist script variable changes to the local values, like the desktop'
    )
    .option('--bail', 'stop on the first request with a failure')
    .option('--delay <ms>', 'milliseconds to wait between requests (integer >= 0)')
    .option(
      '--timeout <ms>',
      `per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}; 0 disables it)`
    )
    .option(
      '--proxy <url>',
      'send every request through this proxy (overrides HTTPS_PROXY/HTTP_PROXY)'
    )
    .option('--no-proxy', 'ignore HTTPS_PROXY / HTTP_PROXY / NO_PROXY for this run')
    .option('--insecure', 'do not verify TLS certificates for this run')
    .option('--reporter-json <file>', "write a JSON report (use '-' for stdout)")
    .option('--reporter-json-no-body', 'omit response bodies from the JSON report')
    .option('--reporter-junit <file>', 'write a JUnit XML report')
    .option('--reporter-html <file>', 'write a standalone HTML report')
    .option('--reporter-html-only-failures', 'open the HTML report with the failures filter active')
    .option('--save-history', 'persist each run to <workspace>/requests/.runs/')
    .option('--suppress-exit-code', 'always exit 0 (still nonzero on fatal errors)')
    .option(
      '--show-secrets',
      'do not redact credentials (Authorization, API keys) and cookie values in output'
    )
    .option('--ascii', 'use ASCII glyphs instead of Unicode')
    .option('--silent', 'suppress stdout (errors still go to stderr)')
    .addOption(
      new Option(
        '-v, --verbose',
        'more detail: -v tests + full URL, -vv headers, -vvv bodies'
      ).argParser((_: string, prev: number) => (prev ?? 0) + 1)
    )
    .option('--no-color', 'disable ANSI colors')

  // `--no-proxy` is commander's negation of `--proxy`, so with both given the
  // last one silently wins. Record each independently so the conflict is
  // reported instead of guessed.
  cmd.on('option:proxy', (value: string) => {
    cmd.setOptionValue('proxyGiven', true)
    cmd.setOptionValue('proxyUrl', value)
  })
  cmd.on('option:no-proxy', () => cmd.setOptionValue('noProxyGiven', true))
  return cmd
}

/**
 * Parse a non-negative integer flag value. Anything else — a word, a negative,
 * a fraction, an exponent, an empty value — is a usage error naming the flag and
 * the value received: a value silently ignored is a CI run that does not do what
 * its definition says.
 */
function parseNonNegativeInt(flag: string, raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined
  const text = String(raw)
  if (!/^\d+$/.test(text.trim()) || text.trim() !== text) {
    throw new CliError(
      EXIT.USAGE,
      `Invalid value for ${flag}: ${JSON.stringify(text)} (expected a whole number of milliseconds, 0 or more)`
    )
  }
  const value = Number(text)
  if (value > MAX_TIMER_MS) {
    throw new CliError(
      EXIT.USAGE,
      `Invalid value for ${flag}: ${text} (the maximum is ${MAX_TIMER_MS} ms)`
    )
  }
  return value
}

/** Shape of the options object commander hands to the run action. */
interface RawRunOpts {
  workspace?: string
  env?: string
  envVar?: string[]
  persistEnv?: boolean
  bail?: boolean
  delay?: string | number
  timeout?: string | number
  /** Set by the `option:proxy` listener (the URL survives a later `--no-proxy`). */
  proxyGiven?: boolean
  proxyUrl?: string
  /** Set by the `option:no-proxy` listener. */
  noProxyGiven?: boolean
  insecure?: boolean
  reporterJson?: string
  reporterJsonNoBody?: boolean
  reporterJunit?: string
  reporterHtml?: string
  reporterHtmlOnlyFailures?: boolean
  saveHistory?: boolean
  suppressExitCode?: boolean
  showSecrets?: boolean
  ascii?: boolean
  silent?: boolean
  verbose?: number
  /** commander maps `--no-color` to `color: false`. */
  color?: boolean
}

/** Translate commander's parsed options + positional paths into {@link RunOptions}. */
export function toRunOptions(paths: string[], raw: RawRunOpts): RunOptions {
  const reporters: ReporterConfig[] = [{ type: 'cli' }]
  if (raw.reporterJson) {
    reporters.push({
      type: 'json',
      output: raw.reporterJson,
      options: { noBody: raw.reporterJsonNoBody ?? false }
    })
  }
  if (raw.reporterJunit) reporters.push({ type: 'junit', output: raw.reporterJunit })
  if (raw.reporterHtml) {
    reporters.push({
      type: 'html',
      output: raw.reporterHtml,
      options: { onlyFailures: raw.reporterHtmlOnlyFailures ?? false }
    })
  }

  const verbosity = Math.min(raw.verbose ?? 0, 3) as Verbosity
  const timeoutMs = parseNonNegativeInt('--timeout', raw.timeout) ?? DEFAULT_TIMEOUT_MS
  const delay = parseNonNegativeInt('--delay', raw.delay)
  if (raw.proxyGiven && raw.noProxyGiven) {
    throw new CliError(EXIT.USAGE, '--proxy and --no-proxy cannot be used together')
  }

  return {
    paths,
    workspace: raw.workspace,
    environment: raw.env,
    envVars: parseEnvVars(raw.envVar),
    persistEnv: raw.persistEnv ?? false,
    ...(raw.proxyGiven && raw.proxyUrl !== undefined ? { proxy: raw.proxyUrl } : {}),
    noProxy: raw.noProxyGiven ?? false,
    bail: raw.bail ?? false,
    delay,
    timeoutMs,
    insecure: raw.insecure ?? false,
    reporters,
    silent: raw.silent ?? false,
    noColor: raw.color === false,
    ascii: raw.ascii ?? false,
    verbosity,
    saveHistory: raw.saveHistory ?? false,
    suppressExitCode: raw.suppressExitCode ?? false,
    showSecrets: raw.showSecrets ?? false
  }
}
