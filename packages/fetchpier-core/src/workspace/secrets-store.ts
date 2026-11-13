/**
 * REQ-0070 — Filesystem access to the workspace secrets manifest
 * (`.fetchpier/secrets.json`). Pure I/O; the crypto and manifest shape live in
 * `../secrets`. Shared by the desktop adapter and the CLI.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, serializeManifest, type SecretsManifest } from '../secrets'
import { atomicWriteFile } from './atomic-write'
import { CoreError } from '../shared/context'
import { describeError } from '../shared/describe-error'

const MANIFEST_FILE = '.fetchpier/secrets.json'

/** Absolute path of the workspace secrets manifest. */
export function secretsManifestPath(workspacePath: string): string {
  return join(workspacePath, MANIFEST_FILE)
}

/**
 * Read and validate the manifest. Returns `null` only when the file does not
 * exist (`ENOENT`, or `ENOTDIR` when `.fetchpier` is not a folder): a workspace
 * with no secrets. Throws `WORKSPACE_INVALID` for a present manifest that cannot
 * be read (permissions, a lock, a directory in its place — SEC-13) or is
 * malformed/unsupported — never mistake it for "no key", never decrypt against it.
 */
export async function readManifest(workspacePath: string): Promise<SecretsManifest | null> {
  const filePath = secretsManifestPath(workspacePath)
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new CoreError(
      'WORKSPACE_INVALID',
      `Secrets manifest could not be read: ${filePath}: ${describeError(err)}`
    )
  }
  return parseManifest(raw)
}

/** Atomically write the manifest (temp + rename). Creates `.fetchpier/` if needed. */
export async function writeManifest(
  workspacePath: string,
  manifest: SecretsManifest
): Promise<void> {
  await atomicWriteFile(secretsManifestPath(workspacePath), serializeManifest(manifest))
}
