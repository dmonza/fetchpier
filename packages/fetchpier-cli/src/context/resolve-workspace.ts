import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

/** A folder is a valid workspace when it contains `.fetchpier/settings.json`. */
export function isValidWorkspace(path: string): boolean {
  return existsSync(join(path, '.fetchpier', 'settings.json'))
}

export interface ResolveWorkspaceInput {
  /** `--workspace` / `-w`. */
  flag?: string
  /** `process.env`. */
  env?: NodeJS.ProcessEnv
  /** `process.cwd()`. */
  cwd?: string
}

/**
 * Resolve the workspace path. Precedence: `--workspace` > `FETCHPIER_WORKSPACE`
 * env var > git-style upward discovery from cwd. Throws {@link CliError} (exit
 * 4) when nothing resolves. Returns an absolute path.
 */
export function resolveWorkspace(input: ResolveWorkspaceInput = {}): string {
  const env = input.env ?? process.env
  const cwd = input.cwd ?? process.cwd()

  if (input.flag) {
    const abs = resolve(input.flag)
    if (!isValidWorkspace(abs)) {
      throw new CliError(EXIT.WORKSPACE, `Workspace not found: ${input.flag}`)
    }
    return abs
  }

  const fromEnv = env.FETCHPIER_WORKSPACE
  if (fromEnv) {
    const abs = resolve(fromEnv)
    if (!isValidWorkspace(abs)) {
      throw new CliError(
        EXIT.WORKSPACE,
        `Workspace not found: ${fromEnv} (from FETCHPIER_WORKSPACE)`
      )
    }
    return abs
  }

  // Auto-discovery: walk up from cwd until a `.fetchpier/` workspace is found,
  // stopping at the filesystem root or above the home directory.
  const stopAt = dirname(homedir())
  let current = resolve(cwd)
  const fsRoot = parse(current).root
  for (;;) {
    if (isValidWorkspace(current)) return current
    if (current === fsRoot || current === stopAt) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  throw new CliError(EXIT.WORKSPACE, 'No Fetchpier workspace found.', [
    'Use --workspace <path> or run from inside a workspace.'
  ])
}
