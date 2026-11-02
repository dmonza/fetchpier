import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'
import { createColors } from '../output/colors'
import { selectGlyphs } from '../output/glyphs'
import type { ReporterConfig } from '../types'
import { CliReporter } from './cli'
import { HtmlReporter } from './html'
import { JsonReporter } from './json'
import { JunitReporter } from './junit'
import type { Reporter } from './types'

export interface ReporterBuildContext {
  ascii: boolean
  noColor: boolean
  silent: boolean
  showSecrets: boolean
  /** Defaults to `process.stdout.isTTY`. */
  isTTY?: boolean
  env?: NodeJS.ProcessEnv
  /** stdout sink for the CLI / JSON-to-stdout reporters — injectable for tests. */
  write?: (s: string) => void
  /** stderr sink — injectable for tests. */
  writeErr?: (s: string) => void
}

const KNOWN = ['cli', 'json', 'junit', 'html'] as const

/**
 * Require a writable output path; the parent directory must already exist.
 *
 * `-` means stdout, and only the JSON reporter implements it. Accepting it for
 * the others created a file named literally `-` in the working directory — the
 * caller asked for stdout and silently got a stray file, so this rejects instead.
 */
function requireOutput(config: ReporterConfig, allowStdout = false): string {
  const output = config.output
  if (!output) {
    throw new CliError(EXIT.REPORTER_OUTPUT, `Reporter '${config.type}' requires an output path`)
  }
  if (output === '-') {
    if (allowStdout) return output
    throw new CliError(
      EXIT.REPORTER_OUTPUT,
      `Reporter '${config.type}' cannot write to stdout ('-'); give it a file path`
    )
  }
  if (!existsSync(dirname(output))) {
    throw new CliError(
      EXIT.REPORTER_OUTPUT,
      `Cannot write report to ${output}: directory does not exist`
    )
  }
  return output
}

/**
 * Build the reporter instances for a run. When a JSON reporter writes to stdout
 * (`output: '-'`), the CLI reporter is silenced so the JSON stays parseable
 * (errors still go to stderr). Multiple reporters are combinable. Unknown
 * reporters fail with exit 9; bad output targets with exit 2.
 */
export function createReporters(configs: ReporterConfig[], ctx: ReporterBuildContext): Reporter[] {
  const jsonToStdout = configs.some((c) => c.type === 'json' && c.output === '-')
  const reporters: Reporter[] = []

  for (const config of configs) {
    switch (config.type) {
      case 'cli':
        reporters.push(
          new CliReporter({
            glyphs: selectGlyphs(ctx.ascii),
            colors: createColors({ noColor: ctx.noColor, isTTY: ctx.isTTY, env: ctx.env }),
            silent: ctx.silent || jsonToStdout,
            write: ctx.write,
            writeErr: ctx.writeErr
          })
        )
        break
      case 'json':
        reporters.push(
          new JsonReporter({
            output: requireOutput(config, true),
            noBody: config.options?.noBody,
            write: ctx.write
          })
        )
        break
      case 'junit':
        reporters.push(new JunitReporter({ output: requireOutput(config) }))
        break
      case 'html':
        reporters.push(
          new HtmlReporter({
            output: requireOutput(config),
            onlyFailures: config.options?.onlyFailures
          })
        )
        break
      default:
        throw new CliError(
          EXIT.UNKNOWN_REPORTER,
          `Unknown reporter: '${config.type}'. Available: ${KNOWN.join(', ')}`
        )
    }
  }

  return reporters
}
