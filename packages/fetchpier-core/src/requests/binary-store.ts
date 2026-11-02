import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import mime from 'mime'
import { resolveInsideWorkspace } from '../workspace/safe-path'
import { atomicWriteFile } from '../workspace/atomic-write'

/**
 * Filesystem layout for binary body attachments. Files are content-addressed by
 * their sha256 digest, prefixed to a sanitized original filename so the on-disk
 * name remains human-readable. Two requests attaching the same file dedupe to
 * one stored copy; sanitization makes the ref portable across operating systems.
 */
export const BINARY_FILES_DIR = ['requests', '.files'] as const

/** Ref format: 64 hex chars + `__` + at least one filename character. */
const REF_PATTERN = /^[a-f0-9]{64}__[^/\\\0]+$/

/** Per-segment sanitizer: strip path-separator and control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g

/**
 * Validate a stored ref. Throws if the ref does not match
 * `<64-hex>__<safe-filename>` — protects callers that build paths from
 * untrusted input (`.http` files, IPC payloads).
 */
export function assertSafeRef(ref: string): string {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
    throw new Error(`Unsafe binary file ref: ${ref}`)
  }
  return ref
}

/**
 * Strip filesystem-unsafe characters from an attachment's original filename.
 * Collapses whitespace runs and trims leading/trailing dots so a sanitized name
 * never starts with `.` (which would hide the file on POSIX) or end with a dot
 * (which Windows treats as the filename without extension).
 */
export function sanitizeOriginalName(name: string): string {
  // Deliberately NOT `path.basename`: that helper is platform-dependent, and it
  // only treats `\` as a separator on Windows. On POSIX it would return
  // `C:\Users\me\file.txt` unchanged and the sanitizer below would turn it into
  // `C__Users_me_file.txt` — the same attachment yielding a different ref per
  // operating system, which breaks the portability this module promises (and
  // therefore dedup inside a workspace shared over git). Split on both
  // separators so the result depends on the input alone.
  const justBase = name.split(/[/\\]/).pop() ?? ''
  const cleaned = justBase.replace(UNSAFE_NAME_CHARS, '_').replace(/\s+/g, ' ').trim()
  const trimmed = cleaned.replace(/^\.+/, '').replace(/\.+$/, '')
  return trimmed.length > 0 ? trimmed : 'file'
}

/** Compute sha256 of a buffer as a lowercase hex string. */
export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Build a ref string from its components without staging. Useful in tests. */
export function buildRef(hash: string, sanitizedName: string): string {
  return `${hash}__${sanitizedName}`
}

/**
 * Look up the MIME type for a filename via the `mime` package. Falls back to
 * `application/octet-stream` when the extension is unknown.
 */
export function lookupMimeType(filename: string): string {
  const ext = extname(filename)
  if (!ext) return 'application/octet-stream'
  return mime.getType(filename) ?? 'application/octet-stream'
}

export interface StagedBinaryFile {
  /** Filename inside `requests/.files/`. */
  ref: string
  /** Sanitized original filename (display only). */
  originalName: string
  /** File size in bytes. */
  sizeBytes: number
  /** Resolved MIME type or `application/octet-stream`. */
  mimeType: string
  /** Absolute path on disk after staging. */
  absolutePath: string
}

/**
 * Copy `sourcePath` into `<workspace>/requests/.files/` under a content-addressed
 * name (`<sha256>__<sanitized-original-name>`). Idempotent: if a file with the
 * same digest+name is already present, no write happens — the existing copy is
 * reused, which is the natural dedupe behavior. Returns the metadata the renderer
 * needs to render the picker UI.
 */
export async function stageBinary(
  workspacePath: string,
  sourcePath: string
): Promise<StagedBinaryFile> {
  const buf = await fs.readFile(sourcePath)
  const hash = hashBuffer(buf)
  const originalName = sanitizeOriginalName(basename(sourcePath))
  const ref = buildRef(hash, originalName)
  const targetDir = resolveInsideWorkspace(workspacePath, ...BINARY_FILES_DIR)
  await fs.mkdir(targetDir, { recursive: true })
  const targetPath = join(targetDir, ref)
  try {
    await fs.access(targetPath)
  } catch {
    await atomicWriteFile(targetPath, buf)
  }
  const mimeType = lookupMimeType(originalName)
  return {
    ref,
    originalName,
    sizeBytes: buf.byteLength,
    mimeType,
    absolutePath: targetPath
  }
}

/**
 * Resolve a stored ref against the workspace. Throws if the ref is malformed or
 * if the resolved path somehow escapes the workspace (defense in depth via
 * `resolveInsideWorkspace`).
 */
export function resolveBinaryRef(workspacePath: string, ref: string): string {
  assertSafeRef(ref)
  return resolveInsideWorkspace(workspacePath, ...BINARY_FILES_DIR, ref)
}

/** Read a staged binary file's bytes. Throws `ENOENT` when the ref is absent. */
export async function readBinary(workspacePath: string, ref: string): Promise<Buffer> {
  return fs.readFile(resolveBinaryRef(workspacePath, ref))
}

/**
 * Remove a staged file. Idempotent: missing files do not error. Returns true
 * when a file was actually deleted.
 */
export async function removeBinary(workspacePath: string, ref: string): Promise<boolean> {
  const target = resolveBinaryRef(workspacePath, ref)
  try {
    await fs.unlink(target)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Read a staged file's metadata. Useful for the parser to backfill size/mime. */
export async function statBinary(
  workspacePath: string,
  ref: string
): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }> {
  try {
    const target = resolveBinaryRef(workspacePath, ref)
    const stat = await fs.stat(target)
    const originalName = ref.slice(66)
    return { exists: true, sizeBytes: stat.size, mimeType: lookupMimeType(originalName) }
  } catch {
    return { exists: false }
  }
}

export interface StagedBinaryListEntry {
  ref: string
  originalName: string
  sizeBytes: number
  mimeType: string
  mtimeMs: number
}

/**
 * List every valid staged file in `<workspace>/requests/.files/`. Used by the
 * UI picker to let the user re-use a file that's already in the workspace
 * instead of re-importing it from disk. Malformed names are skipped silently
 * — the directory is user-visible and may pick up unrelated files. Returns
 * `[]` when the directory does not yet exist (workspace has no binaries).
 * Sorted by `mtimeMs` descending so the most recently staged appear first.
 */
export async function listBinaries(workspacePath: string): Promise<StagedBinaryListEntry[]> {
  const dir = resolveInsideWorkspace(workspacePath, ...BINARY_FILES_DIR)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const results: StagedBinaryListEntry[] = []
  for (const name of entries) {
    if (!REF_PATTERN.test(name)) continue
    try {
      const stat = await fs.stat(join(dir, name))
      if (!stat.isFile()) continue
      const originalName = name.slice(66)
      results.push({
        ref: name,
        originalName,
        sizeBytes: stat.size,
        mimeType: lookupMimeType(originalName),
        mtimeMs: stat.mtimeMs
      })
    } catch {
      // Skip entries we cannot stat (race with deletion, permissions, etc.).
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return results
}
