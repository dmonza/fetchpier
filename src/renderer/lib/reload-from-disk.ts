import { hashString } from '@shared/lib/hash'
import { DEFAULT_REQUEST_STATE, type ParsedHttpFile } from '../../shared/types'
import { useRequestStore } from '../stores/request'
import { isUnreadableFile, loadedTabFields } from './loaded-tab'
import { serializeTab } from './tab-dirty'

/**
 * Resolve a "changed on disk" conflict by adopting the on-disk content, already
 * parsed, and discarding the unsaved edits (REQ open-tab-file-reconciliation).
 * This is the conflict banner's Reload, kept out of `RequestEditor` so the path
 * can be tested without rendering the editor.
 */
export function applyReloadFromDisk(tabId: string, parsed: ParsedHttpFile): void {
  const { tabs, updateTab, markClean } = useRequestStore.getState()
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return
  const loaded = loadedTabFields(parsed, tab.requestId)
  if (!loaded) {
    // ISS-0053: the user chose the on-disk version, which holds no readable
    // request. Discard the edits and the baseline, as Reload always does, so the
    // tab is what a first open of this file leaves: a default request, flagged,
    // with no baseline and so never modified. Keeping the edits against the old
    // baseline would leave the tab modified, and the unsaved-edit guard would
    // then write it over the file.
    if (isUnreadableFile(parsed)) {
      updateTab(tabId, {
        request: { ...DEFAULT_REQUEST_STATE },
        tail: undefined,
        normalizedOnLoad: undefined,
        loadWarnings: undefined,
        cleanHash: undefined,
        isDirty: false,
        conflict: false,
        unreadableOnLoad: true
      })
    }
    return
  }
  updateTab(tabId, { ...loaded, conflict: false })
  markClean(tabId, hashString(serializeTab(loaded)))
}
