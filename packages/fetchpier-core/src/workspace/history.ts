// Activity-log persistence (REQ-0068).
//
// Each send writes one `.http` file under `<workspace>/requests/.runs/`. The
// on-disk format is the neutral activity-log shape from `../activity-log/`,
// with requests-domain extensions added by `./history-format.ts`. Earlier
// `.json` files left over from before REQ-0068 are **ignored** — list/get
// only recognise `.http`; `clear` deletes only `.http`. There is no
// migration (no active users; REQ §3 Impacto).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  buildActivityLogFilename,
  hash4,
  readMetadataPreview,
  serializeActivityLog,
  type ActivityLogFile
} from '../activity-log'
import type { HistoryEntry, HistoryEntryListItem, HistoryListFilter } from '@shared/types'
import { resolveInsideWorkspace } from './safe-path'
import { historyEntryToActivityLog } from './history-format'
import { atomicWriteFile } from './atomic-write'

const HISTORY_DIR = 'requests/.runs'
const HISTORY_EXT = '.http'
const MAX_HISTORY_FILE_SIZE = 5 * 1024 * 1024 // 5 MB — the cap on a full read
/** Enough for the directives and the request line of any run file. */
const HEAD_READ_BYTES = 64 * 1024

function historyDir(workspacePath: string): string {
  return path.join(workspacePath, HISTORY_DIR)
}

async function listHttpFiles(dir: string): Promise<string[]> {
  const all = await fs.readdir(dir).catch(() => [] as string[])
  return all
    .filter((f) => f.endsWith(HISTORY_EXT))
    .sort()
    .reverse()
}

async function readEntryText(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_HISTORY_FILE_SIZE) return null
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * The head of a run file — its first `HEAD_READ_BYTES`, whatever the file's
 * size — for the lookups that need only the header directives (count, delete,
 * remove, get, relink). A cut file loses its last, partial line, so a directive
 * is never read truncated. `null` when the file cannot be read.
 */
async function readEntryHead(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(HEAD_READ_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_READ_BYTES, 0)
    const text = buf.subarray(0, bytesRead).toString('utf-8')
    if (bytesRead < HEAD_READ_BYTES) return text
    const lastEol = text.lastIndexOf('\n')
    return lastEol === -1 ? '' : text.slice(0, lastEol + 1)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function previewOf(text: string): ReturnType<typeof readMetadataPreview> | null {
  try {
    return readMetadataPreview(text)
  } catch {
    return null
  }
}

/**
 * Extract the hash slot from a filename `<ts>-<hash4>-<METHOD>-<slug>.http`.
 * Returns `null` for non-conforming filenames (older or hand-renamed files).
 */
function filenameHashSlot(filename: string): string | null {
  const segments = filename.split('-')
  if (segments.length < 4) return null
  const slot = segments[1]
  if (!slot || !/^[0-9a-f]{4,5}$/.test(slot)) return null
  return slot.length === 4 ? slot : null
}

function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, '/')
}

// ── Public surface ────────────────────────────────────────────────────────

/**
 * Save a history entry. Converts to the neutral activity-log shape, applies
 * the binary placeholder rules to bodies, and writes the resulting `.http`.
 *
 * Filename: `<basic-iso-ts>-<hash4(run-id)>-<METHOD>-<slug>.http` — see
 * `buildActivityLogFilename` for the exact rules.
 */
export async function save(workspacePath: string, entry: HistoryEntry): Promise<void> {
  const dir = historyDir(workspacePath)
  await fs.mkdir(dir, { recursive: true })
  const file: ActivityLogFile = historyEntryToActivityLog(entry)
  const content = serializeActivityLog(file)
  const filename = buildActivityLogFilename({
    timestamp: entry.timestamp,
    runId: entry.id,
    counter: 0,
    method: entry.request.method,
    pathRaw: entry.request.url
  })
  // Defense-in-depth: confine the final path to the workspace even if the
  // filename builder ever regresses.
  const filepath = resolveInsideWorkspace(workspacePath, HISTORY_DIR, filename)
  await atomicWriteFile(filepath, content)
}

/**
 * Enumerate history entries, newest first. The preview is bounded — we only
 * read each file far enough to extract directives + request line + response
 * status line (no bodies, no script blocks). Files that fail to parse are
 * silently skipped. Non-`.http` files (e.g. stale REQ-0067-era `.json`) are
 * ignored.
 *
 * `requestId` / `requestIds` keep only runs of those requests (an empty
 * `requestIds` is no filter). Both apply before `limit`, so a page always
 * holds up to `limit` matching runs.
 */
export async function list(
  workspacePath: string,
  filter?: HistoryListFilter
): Promise<HistoryEntryListItem[]> {
  const dir = historyDir(workspacePath)
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch {
    // ignore
  }

  const files = await listHttpFiles(dir)
  const wantRequestId = filter?.requestId
  const wantRequestIds =
    filter?.requestIds && filter.requestIds.length > 0 ? new Set(filter.requestIds) : null
  const limit = filter?.limit ?? Infinity

  const out: HistoryEntryListItem[] = []
  for (const file of files) {
    if (out.length >= limit) break
    const text = await readEntryText(path.join(dir, file))
    if (text === null) continue
    let preview
    try {
      preview = readMetadataPreview(text)
    } catch {
      continue
    }
    const id = preview.directives['run-id'] ?? ''
    const requestId = preview.directives['request-id']
    if (wantRequestId && requestId !== wantRequestId) continue
    if (wantRequestIds && (requestId === undefined || !wantRequestIds.has(requestId))) continue
    if (!preview.requestLine || !preview.responseStatus) continue
    const item: HistoryEntryListItem = {
      id,
      timestamp: preview.directives['timestamp'] ?? '',
      sourceFile: preview.directives['source-file'] ?? null,
      request: { method: preview.requestLine.method, url: preview.requestLine.url },
      response: {
        status: preview.responseStatus.code,
        statusText: preview.responseStatus.statusText
      }
    }
    if (requestId !== undefined) item.requestId = requestId
    const durRaw = preview.directives['duration-ms']
    if (durRaw !== undefined) {
      const n = Number(durRaw)
      if (Number.isFinite(n)) item.durationMs = n
    }
    const pre = preview.directives['script-pre']
    const post = preview.directives['script-post']
    if (pre !== undefined || post !== undefined) {
      item.scriptSummary = {}
      if (pre !== undefined) item.scriptSummary.pre = pre
      if (post !== undefined) item.scriptSummary.post = post
    }
    out.push(item)
  }
  return out
}

/**
 * Return the raw `.http` text for a given entry. The renderer reconstructs
 * the in-memory `HistoryEntry` via `activityLogToHistoryEntry` from the
 * shared wrapper.
 *
 * Lookup strategy: open files whose filename hash slot matches `hash4(id)`
 * first (fast path), then fall back to a linear scan reading the `# @run-id`
 * directive of each remaining file. The fast path resolves to one file in
 * the typical case; the fallback handles entries whose filenames were
 * renamed by hand or produced by a different (mock) domain where the slot is
 * a counter.
 */
export async function get(workspacePath: string, entryId: string): Promise<string> {
  const dir = historyDir(workspacePath)
  const files = await listHttpFiles(dir)
  const expectedHash = hash4(entryId)

  const fastCandidates: string[] = []
  const slowCandidates: string[] = []
  for (const f of files) {
    const slot = filenameHashSlot(f)
    if (slot === null)
      slowCandidates.push(f) // non-hash filename → check anyway
    else if (slot === expectedHash) fastCandidates.push(f)
  }

  for (const ordered of [fastCandidates, slowCandidates]) {
    for (const file of ordered) {
      const filepath = path.join(dir, file)
      const head = await readEntryHead(filepath)
      if (head === null) continue
      if (previewOf(head)?.directives['run-id'] !== entryId) continue
      // The cap applies to the full read only: the entry exists, it is too big.
      const stat = await fs.stat(filepath).catch(() => null)
      if (stat && stat.size > MAX_HISTORY_FILE_SIZE) {
        throw new Error(
          `history:get — entry too large to open (over ${MAX_HISTORY_FILE_SIZE / (1024 * 1024)} MB): ${entryId}`
        )
      }
      const text = await readEntryText(filepath)
      if (text !== null) return text
    }
  }
  throw new Error(`history:get — entry not found: ${entryId}`)
}

const HEADER_DIRECTIVE_RE = /^# @([A-Za-z][A-Za-z0-9_-]*)(.*)$/

/**
 * Locate the `# @source-file` directive among the header lines, scanning as
 * the activity-log parser does: the header ends at the first line that is
 * neither blank nor `#`-prefixed, and a `# @<name>` … `# @end-<name>` block is
 * skipped whole. `start`/`end` index the original text, line ending excluded.
 */
function findSourceFileLine(text: string): { start: number; end: number; value: string } | null {
  const lines: Array<{ start: number; end: number; text: string }> = []
  const eol = /\r\n|\r|\n/g
  let start = 0
  for (;;) {
    const m = eol.exec(text)
    const end = m ? m.index : text.length
    const line = text.slice(start, end)
    if (line !== '' && !line.startsWith('#')) break
    lines.push({ start, end, text: line })
    if (!m) break
    start = end + m[0].length
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.text.match(HEADER_DIRECTIVE_RE)
    if (!m) continue
    const head = m[1]!
    const rest = m[2]!
    if (!head.startsWith('end-')) {
      const endIdx = lines.findIndex((l, j) => j > i && l.text === `# @end-${head}`)
      if (endIdx > 0) {
        i = endIdx
        continue
      }
    }
    if (head !== 'source-file') continue
    const colonIdx = rest.indexOf(':')
    let value = colonIdx === -1 ? '' : rest.slice(colonIdx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    return { start: lines[i]!.start, end: lines[i]!.end, value }
  }
  return null
}

/**
 * Rewrite the `# @source-file` directive when the originating `.http` is
 * renamed or moved. Only that line changes, as text — the rest of the file
 * (unknown directives, free-form comments, line endings, body bytes) is
 * written back exactly as read.
 */
export async function updateSourceFile(
  workspacePath: string,
  oldRelPath: string,
  newRelPath: string,
  isFolder: boolean
): Promise<void> {
  const dir = historyDir(workspacePath)
  const files = await listHttpFiles(dir)
  const oldNorm = normalizePathSeparators(oldRelPath)
  const newNorm = normalizePathSeparators(newRelPath)
  const prefix = isFolder ? (oldNorm.endsWith('/') ? oldNorm : `${oldNorm}/`) : null

  for (const file of files) {
    const filepath = path.join(dir, file)
    const head = await readEntryHead(filepath)
    if (head === null) continue
    const line = findSourceFileLine(head)
    if (line === null) continue
    const src = normalizePathSeparators(line.value)
    let updated: string | null = null
    if (isFolder && prefix && src.startsWith(prefix)) {
      updated = newNorm.endsWith('/')
        ? `${newNorm}${src.slice(prefix.length)}`
        : `${newNorm}/${src.slice(prefix.length)}`
    } else if (!isFolder && src === oldNorm) {
      updated = newNorm
    }
    if (updated === null) continue
    // The rewrite splices one header line, so it reads the whole file whatever
    // its size — the full-read cap is for parsing, not for this. The head is a
    // prefix of the text, so the line's offsets hold in it.
    const text = await fs.readFile(filepath, 'utf-8').catch(() => null)
    if (text === null || !text.startsWith(head)) continue
    await atomicWriteFile(
      filepath,
      `${text.slice(0, line.start)}# @source-file: ${updated}${text.slice(line.end)}`
    )
  }
}

/**
 * Count entries whose `# @source-file` matches `relPath` (exact when
 * `isFolder=false`, prefix when `isFolder=true`).
 */
export async function countForPath(
  workspacePath: string,
  relPath: string,
  isFolder: boolean
): Promise<number> {
  const dir = historyDir(workspacePath)
  const files = await listHttpFiles(dir)
  const norm = normalizePathSeparators(relPath)
  const prefix = isFolder ? (norm.endsWith('/') ? norm : `${norm}/`) : null
  let count = 0
  for (const file of files) {
    const head = await readEntryHead(path.join(dir, file))
    if (head === null) continue
    const src = previewOf(head)?.directives['source-file']
    if (!src) continue
    const srcNorm = normalizePathSeparators(src)
    if (isFolder && prefix ? srcNorm.startsWith(prefix) : srcNorm === norm) count++
  }
  return count
}

/**
 * Delete entries whose `# @source-file` matches `relPath` (exact when
 * `isFolder=false`, prefix when `isFolder=true`).
 */
export async function deleteForPath(
  workspacePath: string,
  relPath: string,
  isFolder: boolean
): Promise<void> {
  const dir = historyDir(workspacePath)
  const files = await listHttpFiles(dir)
  const norm = normalizePathSeparators(relPath)
  const prefix = isFolder ? (norm.endsWith('/') ? norm : `${norm}/`) : null
  for (const file of files) {
    const filepath = path.join(dir, file)
    const head = await readEntryHead(filepath)
    if (head === null) continue
    const src = previewOf(head)?.directives['source-file']
    if (!src) continue
    const srcNorm = normalizePathSeparators(src)
    if (isFolder && prefix ? srcNorm.startsWith(prefix) : srcNorm === norm) {
      await fs.unlink(filepath).catch(() => undefined)
    }
  }
}

/** Delete one entry by run-id. Silent no-op when the entry can't be found. */
export async function remove(workspacePath: string, entryId: string): Promise<void> {
  const dir = historyDir(workspacePath)
  const files = await listHttpFiles(dir)
  const expectedHash = hash4(entryId)
  // Same fast/slow ordering as `get` for consistency.
  const fast: string[] = []
  const slow: string[] = []
  for (const f of files) {
    const slot = filenameHashSlot(f)
    if (slot === null) slow.push(f)
    else if (slot === expectedHash) fast.push(f)
  }
  for (const ordered of [fast, slow]) {
    for (const file of ordered) {
      const filepath = path.join(dir, file)
      const head = await readEntryHead(filepath)
      if (head === null) continue
      if (previewOf(head)?.directives['run-id'] === entryId) {
        await fs.unlink(filepath).catch(() => undefined)
        return
      }
    }
  }
}

/** Delete every `.http` history file under the workspace. Stale `.json`
 * files (REQ §3 Impacto: ignored after this REQ) are left in place. */
export async function clear(workspacePath: string): Promise<void> {
  const dir = historyDir(workspacePath)
  const files = await listHttpFiles(dir)
  await Promise.all(files.map((f) => fs.unlink(path.join(dir, f)).catch(() => undefined)))
}
