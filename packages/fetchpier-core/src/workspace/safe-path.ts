import path from 'node:path'

/**
 * Resolve `segments` against `workspace` and throw if the result escapes the
 * workspace root. Use for every operation that accepts a filesystem path from
 * outside (renderer IPC, CLI flags).
 */
export function resolveInsideWorkspace(workspace: string, ...segments: string[]): string {
  const root = path.resolve(workspace)
  const resolved = path.resolve(root, ...segments)
  // When `root` is a filesystem root (e.g. `C:\` or `/`), `path.resolve` keeps
  // the trailing separator, so `root + path.sep` would produce `C:\\` / `//`
  // and break the prefix check. Normalize by only appending a separator when
  // the root doesn't already end with one.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes workspace: ${segments.join('/')}`)
  }
  return resolved
}

const FS_SEGMENT_INVALID = /[/\\]|^\.+$|\0/

/**
 * Reject identifiers that could escape a filesystem path (no slashes, no
 * NUL bytes, not a pure dots segment like `..`).
 */
export function assertSafeIdentifier(id: string, label = 'identifier'): string {
  if (!id || typeof id !== 'string' || FS_SEGMENT_INVALID.test(id)) {
    throw new Error(`Unsafe ${label}: ${id}`)
  }
  return id
}
