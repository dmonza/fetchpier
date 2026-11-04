import { listEnvironmentsWithErrors } from '../../context/list-environments'
import { resolveWorkspace } from '../../context/resolve-workspace'
import type { EnvCommandDeps } from './current'

/**
 * `fp env list` — print each environment's **folder name**, one per line. These
 * are exactly the strings `--env` accepts; the opaque identifier is never printed
 * because it is not a selector. An environment folder whose `config.json` cannot
 * be read is named in a warning on stderr instead of silently missing.
 */
export async function listCommand(
  opts: { workspace?: string },
  deps: EnvCommandDeps = {}
): Promise<void> {
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? process.cwd()
  const workspacePath = resolveWorkspace({ flag: opts.workspace, env, cwd })
  const { environments, unreadable } = await listEnvironmentsWithErrors(workspacePath)
  const write = deps.write ?? ((s) => process.stdout.write(s))
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s))
  for (const e of environments) write(`${e.folder}\n`)
  for (const u of unreadable) {
    writeErr(`Warning: environment "${u.folder}" could not be read: ${u.file}: ${u.reason}\n`)
  }
}
