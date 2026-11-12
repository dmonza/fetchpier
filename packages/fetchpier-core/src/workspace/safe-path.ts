import path from 'node:path'
import { PORTABLE_NAME_INVALID_CHAR, WINDOWS_RESERVED } from '../schema-import/sanitize'

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

/**
 * Reject a tree entry name (collection, or request without `.http`) that is not
 * valid on every operating system and in git: an invalid character
 * (`< > : " | ? * / \` or a control character), a trailing dot or space (which
 * also covers `.` and `..`), an empty name, or a Windows device name with or
 * without an extension (`CON`, `nul.backup`). Throws the stable
 * `INVALID_ENTRY_NAME` token the renderer maps to a message.
 */
export function assertPortableName(name: string): string {
  const stem = typeof name === 'string' ? name.split('.')[0].trimEnd().toUpperCase() : ''
  if (
    typeof name !== 'string' ||
    name === '' ||
    PORTABLE_NAME_INVALID_CHAR.test(name) ||
    /[. ]$/.test(name) ||
    WINDOWS_RESERVED.has(stem)
  ) {
    throw new Error(`INVALID_ENTRY_NAME: "${name}" is not a valid name on every operating system`)
  }
  return name
}
