/**
 * Atomic content writes — the target file is left either fully old or fully new
 * after any interruption (crash, kill, power loss, full disk), never truncated
 * or partial. Implemented as temp-file-plus-rename on the *same* directory, so
 * the rename is atomic on the workspace volume. The temp file is flushed to
 * disk (`fsync`) before the rename: a rename alone survives a crash, but after a
 * power loss its metadata can reach the disk before the file's data, leaving an
 * empty target. On POSIX the parent directory is flushed after the rename too,
 * so the rename itself is durable (best-effort; Windows cannot open a directory
 * for a flush, and its rename is journaled by the file system).
 *
 * Shared by the desktop adapter and the CLI: every workspace content writer
 * (request files, workspace settings, cookie jars, certificate metadata, app
 * settings, environment configs) routes its final write through this helper
 * instead of a direct truncate-then-write.
 */
import {
  promises as fsp,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { dirname, basename, join } from 'node:path'

/** Write `data` to `path` and flush it to disk before returning. */
async function writeAndFlush(path: string, data: string | Uint8Array): Promise<void> {
  const fh = await fsp.open(path, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** Synchronous counterpart of {@link writeAndFlush}. */
function writeAndFlushSync(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, 'w')
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Flush a directory so a rename into it is durable. POSIX only: Windows cannot
 * open a directory for a flush. Best-effort — the rename has already landed, so
 * a file system that refuses the flush must not turn a completed save into a
 * failure.
 */
async function flushDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    fh = await fsp.open(dir, 'r')
    await fh.sync()
  } catch {
    // best-effort
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Synchronous counterpart of {@link flushDirectory}. */
function flushDirectorySync(dir: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // best-effort
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * A fresh, collision-resistant temp path next to the target (same directory →
 * same volume). The basename is **dot-prefixed** so the file watcher's dotfile
 * ignore (`/(^|[/\\])\./`) hides the temp file: this keeps an in-flight save from
 * emitting spurious `add`/`unlink`/`change` events that would otherwise look like
 * an external edit (REQ open-tab-file-reconciliation).
 */
function tempPathFor(filePath: string): string {
  const suffix = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return join(dirname(filePath), `.${basename(filePath)}${suffix}`)
}

/**
 * On Windows, `rename` over an existing file can transiently fail with
 * `EPERM`/`EBUSY`/`EACCES` when something else (a concurrent reader of the
 * same path — another IPC read, an editor's own refresh — or AV/indexer
 * scanning) briefly holds the destination open without `FILE_SHARE_DELETE`.
 * POSIX renames are unaffected (already atomic; no such contention), so this
 * check is a no-op there. Confirmed via a reproduced `environments/<id>/config.json`
 * write racing a concurrent read (see `writeEnvFile`'s only caller, `setSecret`).
 */
function isRetryableRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Backoff schedule for a transient rename failure — short and bounded (~775 ms worst case). */
const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400]

/** `fs.rename`, retried with backoff on a transient Windows contention error. */
async function renameWithRetry(tmp: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, filePath)
      return
    } catch (err) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isRetryableRenameError(err)) throw err
      await delay(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/** Synchronous counterpart — blocks via `Atomics.wait` (no event loop to yield to here). */
function renameWithRetrySync(tmp: string, filePath: string): void {
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, filePath)
      return
    } catch (err) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isRetryableRenameError(err)) throw err
      Atomics.wait(sleepBuffer, 0, 0, RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * Atomically write `data` to `filePath` (temp + rename). Creates the parent
 * directory if needed. On failure the previous file content is untouched and
 * the temp file is removed (best-effort).
 */
export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(dirname(filePath), { recursive: true })
  const tmp = tempPathFor(filePath)
  try {
    await writeAndFlush(tmp, data)
    await renameWithRetry(tmp, filePath)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
  await flushDirectory(dirname(filePath))
}

/**
 * Two-phase atomic batch write: write every entry to its temp path, then rename
 * them all into place. If any write fails, every temp is cleaned up and nothing
 * is renamed (the previous on-disk state is intact) — an all-or-nothing batch
 * across multiple files, used by the secrets-key rotation. Callers supply the
 * temp paths (collision-resistant, same directory as the target). Every temp is
 * flushed before the first rename, and each parent directory after the last.
 */
export async function atomicWriteBatch(
  writes: Array<{ finalPath: string; tmpPath: string; content: string | Uint8Array }>
): Promise<void> {
  try {
    for (const w of writes) {
      await fsp.mkdir(dirname(w.finalPath), { recursive: true })
      await writeAndFlush(w.tmpPath, w.content)
    }
  } catch (err) {
    await Promise.all(writes.map((w) => fsp.unlink(w.tmpPath).catch(() => {})))
    throw err
  }
  for (const w of writes) await renameWithRetry(w.tmpPath, w.finalPath)
  for (const d of new Set(writes.map((w) => dirname(w.finalPath)))) await flushDirectory(d)
}

/**
 * Synchronous counterpart for before-quit / first-run paths that cannot await
 * (e.g. app-settings initialisation). Same atomicity guarantee.
 */
export function atomicWriteFileSync(filePath: string, data: string | Uint8Array): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = tempPathFor(filePath)
  try {
    writeAndFlushSync(tmp, data)
    renameWithRetrySync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup
    }
    throw err
  }
  flushDirectorySync(dirname(filePath))
}
