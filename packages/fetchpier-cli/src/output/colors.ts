export interface ColorOptions {
  /** `--no-color` flag. */
  noColor?: boolean
  /** `process.stdout.isTTY`. Defaults to the real stream. */
  isTTY?: boolean
  /** `process.env`. Defaults to the real environment. */
  env?: NodeJS.ProcessEnv
}

/** The colors the CLI output uses. `level` 0 = no color, 1 = basic ANSI colors. */
export interface Colors {
  readonly level: 0 | 1
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
}

/** ECMA-48 SGR: set a basic foreground color, then restore the default one (39). */
function sgr(code: number): (text: string) => string {
  return (text) => (text === '' ? '' : `\u001b[${code}m${text}\u001b[39m`)
}

const identity = (text: string): string => text

function colorsAt(level: 0 | 1): Colors {
  if (level === 0) return { level, red: identity, green: identity, yellow: identity }
  return { level, red: sgr(31), green: sgr(32), yellow: sgr(33) }
}

/**
 * Decide whether ANSI colors are enabled. Precedence (most to least binding):
 * `NO_COLOR` env var (https://no-color.org) and `--no-color` disable; then
 * `FORCE_COLOR` forces on; finally TTY detection decides.
 */
export function createColors(opts: ColorOptions = {}): Colors {
  const env = opts.env ?? process.env
  const isTTY = opts.isTTY ?? process.stdout.isTTY ?? false

  if (opts.noColor || env.NO_COLOR) return colorsAt(0)
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return colorsAt(1)
  return colorsAt(isTTY ? 1 : 0)
}
