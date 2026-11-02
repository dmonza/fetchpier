import { serializeRequest } from '@shared/lib/http-serializer'
import { hashString } from '@shared/lib/hash'
import type { Tab } from '../../shared/types'

/**
 * Serialize a tab to the exact `.http` text that a save would write: the first
 * (edited) request followed by the verbatim multi-request `tail` (`.http`
 * round-trip fidelity). Single source of truth for both the save path and the
 * dirty baseline, so they never diverge.
 */
export function serializeTab(tab: Pick<Tab, 'request' | 'requestId' | 'tail'>): string {
  return serializeRequest(tab.request, tab.requestId) + (tab.tail ?? '')
}

/**
 * Baseline hash of a tab's request as it would be serialized to `.http`. The
 * dirty state compares the live content against the value this returns at the
 * moment a request is loaded or saved (the "clean" point).
 */
export function cleanHashOf(tab: Pick<Tab, 'request' | 'requestId' | 'tail'>): string {
  return hashString(serializeTab(tab))
}

/**
 * Pure, synchronous "is this tab modified?" predicate — the single source of
 * truth for the modified state (REQ-0095). A tab is modified when its serialized
 * `.http` content diverges from the captured baseline, OR when it still holds a
 * malformed query parameter (which can only be cleaned by saving).
 *
 * Returns `false` when no baseline has been captured yet (`cleanHash`
 * undefined) — that is a lazy, file-backed tab that has not been loaded into the
 * editor, so there is nothing the user has edited. Read-only / history tabs are
 * never modified.
 */
export function computeTabDirty(tab: Tab): boolean {
  if (tab.isReadOnly || tab.rawContent !== undefined) return false
  if (tab.cleanHash === undefined) return false
  // The file held content a save would normalize away (stray line / relocated
  // comment) — modified-with-a-reason on load (D19/§6.9, CA-13 flag).
  if (tab.normalizedOnLoad) return true
  if (tab.request.params.some((p) => p.malformed)) return true
  // A malformed multipart part is dropped on save — surface it as modified-with-
  // a-reason so the byte-changing normalization is visible before saving (CA-11).
  if (
    tab.request.multipartParts?.some((p) => (p as { parseError?: string }).parseError !== undefined)
  )
    return true
  return cleanHashOf(tab) !== tab.cleanHash
}
