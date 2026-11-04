import { resolveWorkspace } from '../../context/resolve-workspace'

export interface EnvCommandDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  write?: (s: string) => void
  /** stderr sink — injectable for tests. */
  writeErr?: (s: string) => void
}

/**
 * Resolve the environment a run *would* use, by the CLI's CI-friendly rule:
 * `--env` > `FETCHPIER_ENV` > literal `default`. Deliberately **does not** read
 * the desktop's `WorkspacePrefs.activeEnvironmentId` — so `fp env current` is
 * predictable in CI and unaffected by what the desktop UI last selected.
 */
export function currentEnvironment(opts: { env?: string }, deps: EnvCommandDeps = {}): string {
  const env = deps.env ?? process.env
  return opts.env ?? env.FETCHPIER_ENV ?? 'default'
}

/** `fp env current` — print the resolved environment id. */
export function currentCommand(
  opts: { workspace?: string; env?: string },
  deps: EnvCommandDeps = {}
): void {
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? process.cwd()
  // Resolve the workspace so running outside one errors consistently.
  resolveWorkspace({ flag: opts.workspace, env, cwd })
  const write = deps.write ?? ((s) => process.stdout.write(s))
  write(`${currentEnvironment(opts, deps)}\n`)
}
