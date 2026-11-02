import { Chalk, type ChalkInstance } from 'chalk'

export interface ColorOptions {
  /** `--no-color` flag. */
  noColor?: boolean
  /** `process.stdout.isTTY`. Defaults to the real stream. */
  isTTY?: boolean
  /** `process.env`. Defaults to the real environment. */
  env?: NodeJS.ProcessEnv
}

/**
 * Decide whether ANSI colors are enabled. Precedence (most to least binding):
 * `NO_COLOR` env var (https://no-color.org) and `--no-color` disable; then
 * `FORCE_COLOR` forces on; finally TTY detection decides. Returns a chalk
 * instance with `level` set accordingly (0 = no color, 1 = basic).
 */
export function createColors(opts: ColorOptions = {}): ChalkInstance {
  const env = opts.env ?? process.env
  const isTTY = opts.isTTY ?? process.stdout.isTTY ?? false

  if (opts.noColor || env.NO_COLOR) return new Chalk({ level: 0 })
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return new Chalk({ level: 1 })
  return new Chalk({ level: isTTY ? 1 : 0 })
}
