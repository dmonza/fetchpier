import { useEffect } from 'react'
import { hashString } from '@shared/lib/hash'
import { useRequestStore } from '../stores/request'
import { computeTabDirty, serializeTab } from '../lib/tab-dirty'
import { reconcileContentChange, removedFlagChanges } from '../lib/tab-reconcile'
import { collectAllPaths } from '../lib/tree-paths'
import { isRepointing } from '../lib/repoint-guard'
import { mapHttpRequestToEditorState } from '../components/request/request-loader'
import type { WorkspaceTree } from '../../shared/types'

/**
 * Open-tab reconciliation against the filesystem (REQ
 * open-tab-file-reconciliation). Mounted once at the app root so it covers every
 * open tab regardless of whether the sidebar is visible. Reacts to two watcher
 * signals:
 *
 *  - the whole-tree broadcast (`onChange`) → flag tabs whose backing file
 *    disappeared (moved/deleted externally) and clear the flag when it reappears;
 *  - a single content-change signal (`onFileChanged`) → reload a clean tab to the
 *    new on-disk content, or flag a conflict on a modified one (never a silent
 *    overwrite). The app's own writes are suppressed by a baseline-hash compare.
 *
 * In-app rename/move re-points its tabs synchronously (see `repointTabs`) and
 * registers the paths with the repoint guard, so a self-initiated move never
 * trips the removed-on-disk detection here.
 */
export function useFileSyncReconciliation(): void {
  useEffect(() => {
    // ── External removal / reappearance (whole-tree broadcast) ───────────────
    const onTree = (tree: WorkspaceTree[]): void => {
      const treePaths = new Set(collectAllPaths(tree))
      const { tabs, updateTab } = useRequestStore.getState()
      for (const change of removedFlagChanges(tabs, treePaths, isRepointing)) {
        // Removed-on-disk dominates a stale conflict flag — there is nothing to
        // reload when the file is gone.
        updateTab(
          change.id,
          change.removedOnDisk ? { removedOnDisk: true, conflict: false } : { removedOnDisk: false }
        )
      }
    }

    // ── External content change (single signal) ─────────────────────────────
    const onFileChanged = (filePath: string): void => {
      const { tabs } = useRequestStore.getState()
      const targets = tabs.filter((t) => t.filePath === filePath)
      if (targets.length === 0) return

      void window.api.request
        .parseFile(filePath)
        .then((parsed) => {
          if (parsed.requests.length === 0) return
          const mapped = mapHttpRequestToEditorState(parsed.requests[0])

          // Re-read the live tabs — they may have changed during the async parse.
          const { tabs: live, updateTab, markClean } = useRequestStore.getState()
          for (const tab of live.filter((t) => t.filePath === filePath)) {
            const effectiveId = parsed.requestId ?? tab.requestId
            const newHash = hashString(
              serializeTab({ request: mapped, requestId: effectiveId, tail: parsed.tail })
            )
            const action = reconcileContentChange({
              cleanHash: tab.cleanHash,
              newHash,
              isDirty: computeTabDirty(tab)
            })
            if (action === 'reload') {
              updateTab(tab.id, {
                request: mapped,
                requestId: effectiveId,
                tail: parsed.tail,
                normalizedOnLoad: parsed.requests[0].normalizedOnLoad,
                conflict: false
              })
              markClean(tab.id, newHash)
            } else if (action === 'conflict') {
              updateTab(tab.id, { conflict: true })
            }
            // 'skip' / 'noop' → leave the tab untouched.
          }
        })
        .catch((err) => {
          console.error('[useFileSyncReconciliation] Failed to reconcile file change:', err)
        })
    }

    const offTree = window.api.filesystem.onChange(onTree)
    const offFile = window.api.filesystem.onFileChanged(onFileChanged)
    return () => {
      offTree()
      offFile()
    }
  }, [])
}
