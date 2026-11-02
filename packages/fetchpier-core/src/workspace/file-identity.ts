// REQ case-insensitive tree name uniqueness — the codebase's single
// file-identity comparison. Name/path comparison cannot answer "is this the
// same file?" portably: case-insensitive filesystems resolve differently-cased
// paths to one file, case-sensitive ones to two. The filesystem's own identity
// (device + inode / file index) answers it on every platform.

import { promises as fs } from 'node:fs'

/**
 * Whether `a` and `b` are the same physical file or directory.
 *
 * `bigint: true` is load-bearing: NTFS file indexes are 64-bit and can exceed
 * `Number.MAX_SAFE_INTEGER`, so a number-typed `ino` may truncate two distinct
 * files onto the same value — a false "same file" that would let a rename
 * silently overwrite a sibling.
 *
 * Fails closed: if either path cannot be stat'ed, they are reported as
 * different — callers using this to *exclude* a conflict then keep the
 * conflict, never permit an overwrite.
 */
export async function isSameFile(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  try {
    const [sa, sb] = await Promise.all([fs.stat(a, { bigint: true }), fs.stat(b, { bigint: true })])
    return sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    return false
  }
}
