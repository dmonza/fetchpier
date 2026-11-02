import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

/**
 * Parse repeated `--env-var "KEY=VALUE"` arguments into a record. The value may
 * contain `=` (only the first one splits). An entry without `=`, or with an
 * empty key, is a usage error → exit 7.
 */
export function parseEnvVars(args: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!args) return out
  for (const arg of args) {
    const eq = arg.indexOf('=')
    if (eq <= 0) {
      throw new CliError(EXIT.ENV_VAR, `Malformed --env-var: expected KEY=VALUE, got '${arg}'`)
    }
    const key = arg.slice(0, eq)
    const value = arg.slice(eq + 1)
    out[key] = value
  }
  return out
}
