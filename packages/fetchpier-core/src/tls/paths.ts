import { createHash } from 'node:crypto'
import { join } from 'node:path'

const SCOPE_DIR = '.fetchpier/certs'

/** Canonical certificate directory for a workspace. */
export function workspaceCertsDir(workspacePath: string): string {
  return join(workspacePath, SCOPE_DIR)
}

// Whitelist: only [a-zA-Z0-9._-] survive. Whitespace is normalised to '-' first;
// everything else (path separators, shell metacharacters, control bytes) is stripped.
const INVALID_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g

/**
 * Strip filesystem-unsafe characters from a label, collapse whitespace into
 * single dashes, lowercase the result. Returns `'cert'` if nothing usable remains.
 */
export function sanitiseFilename(label: string): string {
  const cleaned = label
    .replace(/\s+/g, '-')
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .toLowerCase()
  return cleaned || 'cert'
}

/** 4 hex characters of the SHA-256 content hash. Enough to disambiguate dozens of entries per scope. */
export function shortContentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 4)
}

/** Build the canonical filename: `<sanitised-prefix>-<hash>.<ext>`. */
export function canonicalCertFilename(prefix: string, content: Buffer, ext: string): string {
  const normalisedExt = ext.startsWith('.') ? ext.slice(1) : ext
  return `${sanitiseFilename(prefix)}-${shortContentHash(content)}.${normalisedExt}`
}
