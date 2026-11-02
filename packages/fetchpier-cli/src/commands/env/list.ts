import { listEnvironments } from '../../context/list-environments'
import { resolveWorkspace } from '../../context/resolve-workspace'
import type { EnvCommandDeps } from './current'

/**
 * `fp env list` — print each environment's **folder name**, one per line. These
 * are exactly the strings `--env` accepts; the opaque identifier is never printed
 * because it is not a selector.
 */
export async function listCommand(
  opts: { workspace?: string },
  deps: EnvCommandDeps = {}
): Promise<void> {
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? process.cwd()
  const workspacePath = resolveWorkspace({ flag: opts.workspace, env, cwd })
  const envs = await listEnvironments(workspacePath)
  const write = deps.write ?? ((s) => process.stdout.write(s))
  for (const e of envs) write(`${e.folder}\n`)
}
