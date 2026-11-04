import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { CliError } from '../../errors'
import { EXIT } from '../../exit-codes'

/** Recursively collect `.http` files under a directory, sorted for determinism. */
async function collectHttpFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  // Sort entries so traversal order is stable across platforms.
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    // Skip app-state and run-log folders.
    if (entry.isDirectory()) {
      if (entry.name === '.fetchpier' || entry.name === '.runs' || entry.name === '.git') continue
      out.push(...(await collectHttpFiles(join(dir, entry.name))))
    } else if (entry.isFile() && entry.name.endsWith('.http')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

async function statOrNull(abs: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(abs)
  } catch {
    return null
  }
}

/**
 * The "did you mean" hint for a relative path that is missing from the current
 * directory but present under the workspace root. Advisory only — resolution
 * never falls back to the workspace; the user is told what to type instead.
 * The suggestion is the workspace candidate expressed relative to `cwd`, with
 * forward slashes (accepted by every supported shell, and how reports print paths).
 */
async function suggestionFor(
  p: string,
  abs: string,
  cwd: string,
  workspacePath: string
): Promise<string[]> {
  if (isAbsolute(p)) return []
  const candidate = resolve(workspacePath, p)
  if (candidate === abs) return []
  const stat = await statOrNull(candidate)
  if (!stat || !(stat.isDirectory() || candidate.endsWith('.http'))) return []
  const suggested = relative(cwd, candidate).split('\\').join('/')
  return [`Did you mean ${suggested}? Paths are relative to the current directory.`]
}

/**
 * Expand the CLI's input paths into a flat, ordered list of absolute `.http`
 * file paths. Explicit paths resolve against `cwd` (a path may be a single
 * `.http` file or a folder, recursed). With no path, the target is the
 * workspace's own `requests/` tree — derived from `workspacePath`, never from
 * `cwd`, so the default is the same from any directory. A missing path aborts
 * with exit 5, with a suggestion when the path exists relative to the workspace.
 */
export async function expandPaths(
  paths: string[],
  cwd: string,
  workspacePath: string
): Promise<string[]> {
  if (paths.length === 0) {
    const requestsDir = join(workspacePath, 'requests')
    const stat = await statOrNull(requestsDir)
    if (!stat?.isDirectory()) {
      throw new CliError(EXIT.PATH_NOT_FOUND, `No requests folder in the workspace: ${requestsDir}`)
    }
    return collectHttpFiles(requestsDir)
  }

  const files: string[] = []
  for (const p of paths) {
    const abs = resolve(cwd, p)
    const stat = await statOrNull(abs)
    if (!stat) {
      throw new CliError(
        EXIT.PATH_NOT_FOUND,
        `Path not found: ${p}`,
        await suggestionFor(p, abs, cwd, workspacePath)
      )
    }
    if (stat.isDirectory()) {
      files.push(...(await collectHttpFiles(abs)))
    } else if (abs.endsWith('.http')) {
      files.push(abs)
    } else {
      throw new CliError(EXIT.PATH_NOT_FOUND, `Not a .http file or folder: ${p}`)
    }
  }
  return files
}
