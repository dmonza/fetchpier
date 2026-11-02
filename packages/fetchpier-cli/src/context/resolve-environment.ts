import type { Environment } from '@shared/types'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'
import { listEnvironments } from './list-environments'

export interface ResolveEnvironmentInput {
  /** `--env` / `-e`. */
  flag?: string
  /** `process.env`. */
  env?: NodeJS.ProcessEnv
  workspacePath: string
}

export interface ResolvedEnvironment {
  /**
   * The environment's **opaque identifier**, passed to core so it can resolve the
   * folder for the cookie jar and the per-machine local values. Not a selector:
   * it is not meant to be typed.
   */
  id: string
  /**
   * The environment's **folder name** — what `--env` matched, what `fp env list`
   * prints, and what version control tracks.
   */
  folder: string
  /**
   * REQ-0076: the unified variables map. Value shape classifies — plain string,
   * `enc:` ciphertext, or `null` (needs-value secret). Used to resolve
   * `{{placeholders}}` (plain) and to feed the secret resolver (`enc:`/`null`).
   */
  variables: Record<string, string | null>
}

/**
 * Resolve the active environment. Precedence: `--env` > `FETCHPIER_ENV` >
 * literal `default`.
 *
 * Matched **case-insensitively against the folder name**, not the identifier: the
 * identifier is opaque and unreadable in a pipeline definition, while the folder
 * is what git tracks and what a rename shows in the diff. For every workspace
 * created before the identity split the two strings are identical, so existing
 * invocations are unaffected.
 *
 * Never reads `WorkspacePrefs` (Option A) — predictable in CI. Throws
 * {@link CliError} (exit 6) when the selected environment does not exist, naming
 * the source for diagnosis and listing the available folder names.
 */
export async function resolveEnvironment(
  input: ResolveEnvironmentInput
): Promise<ResolvedEnvironment> {
  let name: string
  let source: string | null

  if (input.flag) {
    name = input.flag
    source = '--env'
  } else if ((input.env ?? process.env).FETCHPIER_ENV) {
    name = (input.env ?? process.env).FETCHPIER_ENV as string
    source = 'FETCHPIER_ENV'
  } else {
    name = 'default'
    source = null
  }

  const envs = await listEnvironments(input.workspacePath)
  const match = envs.find((e) => e.folder.toLowerCase() === name.toLowerCase())
  if (!match) {
    throw new CliError(EXIT.ENVIRONMENT, environmentNotFoundMessage(name, source), [
      `Available: ${availableList(envs)}.`,
      ...(source ? [] : [`Use --env <name> or set FETCHPIER_ENV.`])
    ])
  }

  return { id: match.id, folder: match.folder, variables: match.variables ?? {} }
}

function environmentNotFoundMessage(name: string, source: string | null): string {
  if (source) return `Environment '${name}' not found (from ${source})`
  return `No environment specified and no 'default' environment exists`
}

function availableList(envs: Environment[]): string {
  if (envs.length === 0) return '(none)'
  return envs.map((e) => e.folder).join(', ')
}
