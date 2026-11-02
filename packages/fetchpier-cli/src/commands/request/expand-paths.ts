import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
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

/**
 * Expand the CLI's input paths (relative to `cwd`) into a flat, ordered list of
 * absolute `.http` file paths. A path may be a single `.http` file or a folder
 * (recursed). A path that does not exist aborts with exit 5.
 */
export async function expandPaths(paths: string[], cwd: string): Promise<string[]> {
  const files: string[] = []
  for (const p of paths) {
    const abs = resolve(cwd, p)
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(abs)
    } catch {
      throw new CliError(EXIT.PATH_NOT_FOUND, `Path not found: ${p}`)
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
