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

/**
 * `fs.rename`, retried with backoff on a transient Windows contention error.
 * Exported for the core's other rename call sites — the tree mutations'
 * rename/move cascade, an environment's folder rename, and this module's batch
 * rollback — so every rename in the workspace shares one retry schedule and one
 * retryable-error rule. Its callers all live in this folder; the `workspace`
 * barrel re-exports it anyway (`export *`).
 */
export async function renameWithRetry(tmp: string, filePath: string): Promise<void> {
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

/** A target an {@link atomicWriteBatch} rollback could not put back. */
export interface StrandedBatchTarget {
  /** The target, still holding the batch's new content (or present when it was new). */
  finalPath: string
  /** A dot-prefixed file beside it holding its previous content; `null` when it had none. */
  backupPath: string | null
}

/**
 * An {@link atomicWriteBatch} whose rename phase failed and whose rollback could
 * not restore every target. `cause` is the rename error that started the
 * rollback; `stranded` lists what was left at its new content. Every other
 * target was restored.
 */
export class AtomicBatchRollbackError extends Error {
  constructor(
    public readonly stranded: StrandedBatchTarget[],
    public readonly cause: unknown
  ) {
    super(
      `The batch write failed (${cause instanceof Error ? cause.message : String(cause)}) and ` +
        `could not be fully undone: ${stranded.map((s) => s.finalPath).join(', ')}`
    )
    this.name = 'AtomicBatchRollbackError'
    // Same reason as CoreError: keep `instanceof` working after transpilation.
    Object.setPrototypeOf(this, AtomicBatchRollbackError.prototype)
  }
}

/** A dot-prefixed backup path beside `filePath` (hidden from the watcher, like temps). */
function backupPathFor(filePath: string): string {
  const suffix = `.bak-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return join(dirname(filePath), `.${basename(filePath)}${suffix}`)
}

/**
 * A flushed copy of `filePath`'s current content, or `null` when it does not
 * exist. Flushed so that restoring it by rename is as durable as any write.
 */
async function backUp(filePath: string): Promise<string | null> {
  let previous: Buffer
  try {
    previous = await fsp.readFile(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const backup = backupPathFor(filePath)
  try {
    await writeAndFlush(backup, previous)
  } catch (err) {
    await fsp.unlink(backup).catch(() => {})
    throw err
  }
  return backup
}

function assertDistinctPaths(writes: ReadonlyArray<{ finalPath: string; tmpPath: string }>): void {
  const finals = new Set<string>()
  const temps = new Set<string>()
  for (const w of writes) {
    if (finals.has(w.finalPath)) {
      throw new Error(`atomicWriteBatch: two entries write the same target: ${w.finalPath}`)
    }
    if (temps.has(w.tmpPath)) {
      throw new Error(`atomicWriteBatch: two entries share the same temp path: ${w.tmpPath}`)
    }
    finals.add(w.finalPath)
    temps.add(w.tmpPath)
  }
}

/**
 * Two-phase atomic batch write, all-or-nothing across every file — used by the
 * secrets-key rotation.
 *
 * 1. Write every entry to its temp path (flushed), and copy every existing
 *    target to a flushed, dot-prefixed backup beside it. Any failure removes
 *    every temp and backup; nothing was renamed.
 * 2. Rename the temps into place, in order, through {@link renameWithRetry}. If
 *    a rename still fails, the targets already replaced are put back (last
 *    first): a backup is renamed onto its target, a target the batch created
 *    is removed. The remaining temps and unused backups are removed, and the
 *    original error is rethrown. A rollback step that fails does not stop the
 *    others; the batch then rejects with {@link AtomicBatchRollbackError}
 *    naming each target left at its new content, whose backup is kept.
 *
 * On success each parent directory is flushed and the backups are removed.
 * Callers supply the temp paths (collision-resistant, same directory as the
 * target); two entries with the same target or temp path are refused before
 * anything is written. A crash during the rename phase cannot roll back:
 * targets renamed before it stay new, and the temps and backups stay on disk.
 */
export async function atomicWriteBatch(
  writes: Array<{ finalPath: string; tmpPath: string; content: string | Uint8Array }>
): Promise<void> {
  assertDistinctPaths(writes)
  const backups: Array<string | null> = []
  try {
    for (const w of writes) {
      await fsp.mkdir(dirname(w.finalPath), { recursive: true })
      await writeAndFlush(w.tmpPath, w.content)
      backups.push(await backUp(w.finalPath))
    }
  } catch (err) {
    await Promise.all([
      ...writes.map((w) => fsp.unlink(w.tmpPath).catch(() => {})),
      ...backups.map((b) => (b ? fsp.unlink(b).catch(() => {}) : undefined))
    ])
    throw err
  }

  for (let i = 0; i < writes.length; i++) {
    try {
      await renameWithRetry(writes[i].tmpPath, writes[i].finalPath)
    } catch (err) {
      await rollBackBatch(writes, backups, i, err)
    }
  }
  for (const d of new Set(writes.map((w) => dirname(w.finalPath)))) await flushDirectory(d)
  await Promise.all(backups.map((b) => (b ? fsp.unlink(b).catch(() => {}) : undefined)))
}

/**
 * Undo the renames before `failedAt`, clean up what the batch left, and throw:
 * the original error when every target was restored, otherwise an
 * {@link AtomicBatchRollbackError}.
 */
async function rollBackBatch(
  writes: ReadonlyArray<{ finalPath: string; tmpPath: string }>,
  backups: ReadonlyArray<string | null>,
  failedAt: number,
  cause: unknown
): Promise<never> {
  const stranded: StrandedBatchTarget[] = []
  for (let j = failedAt - 1; j >= 0; j--) {
    const { finalPath } = writes[j]
    const backupPath = backups[j]
    try {
      if (backupPath) await renameWithRetry(backupPath, finalPath)
      else await fsp.unlink(finalPath)
    } catch {
      stranded.push({ finalPath, backupPath })
    }
  }
  await Promise.all(
    writes.slice(failedAt).flatMap((w, k) => {
      const b = backups[failedAt + k]
      return [fsp.unlink(w.tmpPath).catch(() => {}), b ? fsp.unlink(b).catch(() => {}) : undefined]
    })
  )
  if (stranded.length > 0) throw new AtomicBatchRollbackError(stranded.reverse(), cause)
  throw cause
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
