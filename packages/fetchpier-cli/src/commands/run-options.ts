import { Command, Option } from 'commander'
import { parseEnvVars } from '../context/parse-env-vars'
import type { ReporterConfig, RunOptions, Verbosity } from '../types'

/**
 * Attach every `fp run` flag to a commander command. Shared by the canonical
 * `fp request run` and the top-level `fp run` alias so they stay byte-identical.
 */
export function addRunOptions(cmd: Command): Command {
  return cmd
    .argument('[paths...]', 'one or more .http files or folders (default: the workspace requests/)')
    .option('-w, --workspace <path>', 'workspace folder (default: discovered from cwd)')
    .option('-e, --env <name>', 'environment id (default: FETCHPIER_ENV or "default")')
    .option(
      '--env-var <pair>',
      'override a variable as KEY=VALUE (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option('--bail', 'stop on the first request with a failure')
    .option('--delay <ms>', 'milliseconds to wait between requests', (v) => Number(v))
    .option('--timeout <ms>', 'per-request timeout in milliseconds', (v) => Number(v))
    .option('--insecure', 'do not verify TLS certificates for this run')
    .option('--reporter-json <file>', "write a JSON report (use '-' for stdout)")
    .option('--reporter-json-no-body', 'omit response bodies from the JSON report')
    .option('--reporter-junit <file>', 'write a JUnit XML report')
    .option('--reporter-html <file>', 'write a standalone HTML report')
    .option('--reporter-html-only-failures', 'open the HTML report with the failures filter active')
    .option('--save-history', 'persist each run to <workspace>/requests/.runs/')
    .option('--suppress-exit-code', 'always exit 0 (still nonzero on fatal errors)')
    .option('--show-secrets', 'do not redact Authorization headers in reports')
    .option('--ascii', 'use ASCII glyphs instead of Unicode')
    .option('--silent', 'suppress stdout (errors still go to stderr)')
    .addOption(
      new Option('-v, --verbose', 'increase verbosity (repeatable: -v, -vv, -vvv)').argParser(
        (_: string, prev: number) => (prev ?? 0) + 1
      )
    )
    .option('--no-color', 'disable ANSI colors')
}

/** Shape of the options object commander hands to the run action. */
interface RawRunOpts {
  workspace?: string
  env?: string
  envVar?: string[]
  bail?: boolean
  delay?: number
  timeout?: number
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

  return {
    paths,
    workspace: raw.workspace,
    environment: raw.env,
    envVars: parseEnvVars(raw.envVar),
    bail: raw.bail ?? false,
    delay: raw.delay,
    timeoutMs: raw.timeout,
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
