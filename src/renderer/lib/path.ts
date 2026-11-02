/**
 * Returns the last segment of a filesystem path. Works for both POSIX (`/`) and
 * Windows (`\`) separators, since paths can flow through the renderer from
 * either platform.
 */
export function basenameOfPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? filePath
}
