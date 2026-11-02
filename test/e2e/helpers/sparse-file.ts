import { promises as fs } from 'node:fs'

/**
 * Create a sparse file of `sizeBytes`. `fs.stat().size` returns the requested
 * size even though no data blocks are written, so the file consumes ~0 bytes
 * of real disk on NTFS / ext4 / APFS. Reads return zero-filled bytes.
 *
 * Used by binary-body-limits.spec.ts to exercise the 49 / 75 / 150 MB default
 * thresholds without committing 274 MB of disk I/O per test.
 */
export async function createSparseFile(path: string, sizeBytes: number): Promise<void> {
  const fd = await fs.open(path, 'w')
  try {
    await fd.truncate(sizeBytes)
  } finally {
    await fd.close()
  }
}
