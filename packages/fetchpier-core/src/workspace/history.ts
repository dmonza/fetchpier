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
  parseActivityLog,
  readMetadataPreview,
  serializeActivityLog,
  type ActivityLogFile
} from '../activity-log'
import type { HistoryEntry, HistoryEntryListItem } from '@shared/types'
import { resolveInsideWorkspace } from './safe-path'
import { historyEntryToActivityLog } from './history-format'
import { atomicWriteFile } from './atomic-write'

const HISTORY_DIR = 'requests/.runs'
const HISTORY_EXT = '.http'
const MAX_HISTORY_FILE_SIZE = 5 * 1024 * 1024 // 5 MB — anything larger is ignored

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
 */
export async function list(
  workspacePath: string,
  filter?: { requestId?: string; limit?: number }
): Promise<HistoryEntryListItem[]> {
  const dir = historyDir(workspacePath)
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch {
    // ignore
  }

  const files = await listHttpFiles(dir)
  const wantRequestId = filter?.requestId
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
      const text = await readEntryText(path.join(dir, file))
      if (text === null) continue
      let preview
      try {
        preview = readMetadataPreview(text)
      } catch {
        continue
      }
      if (preview.directives['run-id'] === entryId) return text
    }
  }
  throw new Error(`history:get — entry not found: ${entryId}`)
}

/**
 * Rewrite the `# @source-file` directive when the originating `.http` is
 * renamed or moved. Round-trip lossless — the rest of the file (including
 * unknown directives + free-form comments + body bytes) is untouched.
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
    const text = await readEntryText(filepath)
    if (text === null) continue
    let parsed: ActivityLogFile
    try {
      parsed = parseActivityLog(text)
    } catch {
      continue
    }
    const idx = parsed.header.findIndex((it) => it.kind === 'directive' && it.key === 'source-file')
    if (idx < 0) continue
    const dir_ = parsed.header[idx]
    if (dir_.kind !== 'directive') continue
    const src = normalizePathSeparators(dir_.value)
    let updated: string | null = null
    if (isFolder && prefix && src.startsWith(prefix)) {
      updated = newNorm.endsWith('/')
        ? `${newNorm}${src.slice(prefix.length)}`
        : `${newNorm}/${src.slice(prefix.length)}`
    } else if (!isFolder && src === oldNorm) {
      updated = newNorm
    }
    if (updated === null) continue
    parsed.header[idx] = { kind: 'directive', key: 'source-file', value: updated }
    await atomicWriteFile(filepath, serializeActivityLog(parsed))
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
    const text = await readEntryText(path.join(dir, file))
    if (text === null) continue
    let preview
    try {
      preview = readMetadataPreview(text)
    } catch {
      continue
    }
    const src = preview.directives['source-file']
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
    const text = await readEntryText(filepath)
    if (text === null) continue
    let preview
    try {
      preview = readMetadataPreview(text)
    } catch {
      continue
    }
    const src = preview.directives['source-file']
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
      const text = await readEntryText(filepath)
      if (text === null) continue
      let preview
      try {
        preview = readMetadataPreview(text)
      } catch {
        continue
      }
      if (preview.directives['run-id'] === entryId) {
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
