// Lazy resolution of open tabs' stable request ids (ISS-0081).
//
// A restored session builds its tabs without reading their files, so each tab
// starts with a session-random `requestId` and `requestIdSource: undefined`
// until the editor loads it on activation. The History panel filters runs by
// request id, so it calls this when it is shown: each file-backed tab still
// unresolved is read once (`http:parseFile`) and gets its file's `# @id`, or —
// when the file has none or cannot be read — keeps its own id, marked
// `'generated'` so the panel also matches the file's runs by path. Session
// restore itself stays free of file reads (Performance 1).

import type { Tab } from '../../shared/types'
import { useRequestStore } from '../stores/request'

/** Tab ids whose file read is in flight — one read per tab at a time. */
const inFlight = new Set<string>()

/** A tab the History panel shows a chip for: an editable, saved request. */
export function isHistoryChipCandidate(tab: Tab): boolean {
  return Boolean(tab.requestId && tab.filePath && !tab.isReadOnly && tab.rawContent === undefined)
}

/** A chip candidate whose request id has not been read from its file yet. */
export function needsRequestIdResolution(tab: Tab): boolean {
  return isHistoryChipCandidate(tab) && tab.requestIdSource === undefined
}

async function readFileRequestId(filePath: string): Promise<string | undefined> {
  try {
    return (await window.api.request.parseFile(filePath)).requestId
  } catch (err) {
    console.error('[resolveTabRequestIds] Failed to read the request id:', err)
    return undefined
  }
}

/**
 * Resolve every unresolved chip candidate's request id. A tab loaded by the
 * editor meanwhile (it then has a `requestIdSource`) or closed is left alone; a
 * tab moved to another path meanwhile is read again at its new path.
 */
export async function resolveTabRequestIds(): Promise<void> {
  const pending = useRequestStore
    .getState()
    .tabs.filter((t) => needsRequestIdResolution(t) && !inFlight.has(t.id))
  if (pending.length === 0) return
  let moved = false
  await Promise.all(
    pending.map(async (tab) => {
      const filePath = tab.filePath!
      inFlight.add(tab.id)
      let fileId: string | undefined
      try {
        fileId = await readFileRequestId(filePath)
      } finally {
        inFlight.delete(tab.id)
      }
      const store = useRequestStore.getState()
      const current = store.tabs.find((t) => t.id === tab.id)
      if (!current || current.requestIdSource !== undefined) return
      if (current.filePath !== filePath) {
        moved = true
        return
      }
      store.updateTab(
        tab.id,
        fileId ? { requestId: fileId, requestIdSource: 'file' } : { requestIdSource: 'generated' }
      )
    })
  )
  if (moved) await resolveTabRequestIds()
}
