/**
 * REQ-0070 — Filesystem access to the workspace secrets manifest
 * (`.fetchpier/secrets.json`). Pure I/O; the crypto and manifest shape live in
 * `../secrets`. Shared by the desktop adapter and the CLI.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, serializeManifest, type SecretsManifest } from '../secrets'
import { atomicWriteFile } from './atomic-write'

const MANIFEST_FILE = '.fetchpier/secrets.json'

/** Absolute path of the workspace secrets manifest. */
export function secretsManifestPath(workspacePath: string): string {
  return join(workspacePath, MANIFEST_FILE)
}

/**
 * Read and validate the manifest. Returns `null` when the file does not exist
 * (a workspace with no secrets). Throws `WORKSPACE_INVALID` for a present but
 * malformed/unsupported manifest — never decrypt against a broken manifest.
 */
export async function readManifest(workspacePath: string): Promise<SecretsManifest | null> {
  let raw: string
  try {
    raw = await fs.readFile(secretsManifestPath(workspacePath), 'utf-8')
  } catch {
    return null
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
