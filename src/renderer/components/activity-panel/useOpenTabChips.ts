import { useEffect, useMemo, useRef } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { useRequestStore } from '../../stores/request'
import { useHistoryChipsStore, type OpenRequestChip } from '../../stores/historyChips'
import {
  isHistoryChipCandidate,
  needsRequestIdResolution,
  resolveTabRequestIds
} from '../../lib/resolve-tab-request-ids'

/**
 * Build a display label for a request chip. Uses the file basename when the
 * request lives at the requests root; otherwise prefixes with the immediate
 * parent folder so two files with the same basename (e.g. two
 * `transcription.http` in different folders) get visually distinct chips.
 */
function deriveChipLabel(absFilePath: string, workspacePath: string | null): string {
  const sepCandidates = /[/\\]/
  let rel = absFilePath
  if (workspacePath && absFilePath.startsWith(workspacePath)) {
    rel = absFilePath.slice(workspacePath.length).replace(/^[/\\]+/, '')
  }
  // Strip the "requests/" prefix (common to every request file) and the .http suffix.
  rel = rel.replace(/^requests[/\\]/i, '').replace(/\.http$/i, '')
  const parts = rel.split(sepCandidates).filter(Boolean)
  if (parts.length === 0) return absFilePath
  if (parts.length === 1) return parts[0]!
  // Show parent/basename when nested — keeps the chip compact but disambiguates.
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

/**
 * Workspace-relative path of a request file, as a send records it in
 * `# @source-file` (`RequestEditor`); `null` outside the workspace.
 */
function workspaceRelative(absFilePath: string, workspacePath: string | null): string | null {
  if (!workspacePath || !absFilePath.startsWith(workspacePath)) return null
  return absFilePath.slice(workspacePath.length).replace(/^[/\\]+/, '')
}

/**
 * Keep the History chip set in step with this window's open tabs: the docked
 * `HistoryList`, and the main window's publisher while the panel is detached
 * (ISS-0073). The popout passes `enabled: false` — it has no tabs and shows
 * the main window's set instead.
 *
 * Returns whether the set is complete: every tab's id is read and the chips
 * mirror the tabs (always `false` when disabled).
 */
export function useOpenTabChips(enabled: boolean): boolean {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const allTabs = useRequestStore((s) => s.tabs)
  const chips = useHistoryChipsStore((s) => s.chips)
  const syncChips = useHistoryChipsStore((s) => s.syncChips)
  const resetChips = useHistoryChipsStore((s) => s.reset)

  // ISS-0081: a restored tab carries a session-random id until its file is
  // read. Read the unresolved tabs' `# @id` now that the history is shown (not
  // at session restore), and leave them out of the chip set until then — a
  // checked chip with a random id would hide the request's runs.
  const unresolvedCount = allTabs.filter(needsRequestIdResolution).length
  useEffect(() => {
    if (enabled && unresolvedCount > 0) void resolveTabRequestIds()
  }, [enabled, allTabs, unresolvedCount])

  // Mirror the open editor tabs into the chip set. Tabs without a `filePath`
  // (untitled), read-only history views, or raw `.http` views are excluded —
  // they'd be unhelpful labels with no source identity. Each render syncs:
  // new tabs add chips (checked by default), closed tabs remove their chip,
  // existing chips keep their checked state. A file with no `# @id` also
  // matches its runs by path (its sends each recorded a session's own id).
  // One chip per request id, as `syncChips` keeps: two files can share an `# @id`.
  const openChips = useMemo(() => {
    const seen = new Set<string>()
    return allTabs
      .filter(
        (t) =>
          isHistoryChipCandidate(t) &&
          t.requestIdSource !== undefined &&
          !seen.has(t.requestId) &&
          seen.add(t.requestId)
      )
      .map((t) => {
        const chip: OpenRequestChip = {
          requestId: t.requestId,
          label: deriveChipLabel(t.filePath!, workspacePath)
        }
        const sourceFile =
          t.requestIdSource === 'generated' ? workspaceRelative(t.filePath!, workspacePath) : null
        if (sourceFile) chip.sourceFile = sourceFile
        return chip
      })
  }, [allTabs, workspacePath])

  // Reset the chips ONLY on a real workspace change. The initial mount must not
  // reset — otherwise it would wipe the checked state the chips already carry
  // (from another panel instance, or from before the panel was detached).
  const prevWorkspaceRef = useRef(workspacePath)
  useEffect(() => {
    if (!enabled || prevWorkspaceRef.current === workspacePath) return
    prevWorkspaceRef.current = workspacePath
    resetChips()
  }, [enabled, workspacePath, resetChips])

  // `chips` is a dependency so a reset (workspace change) re-syncs; syncChips
  // is a no-op when nothing differs.
  useEffect(() => {
    if (enabled) syncChips(openChips)
  }, [enabled, openChips, chips, syncChips])

  const chipsInSync =
    chips.length === openChips.length &&
    chips.every(
      (c, i) => c.requestId === openChips[i]!.requestId && c.sourceFile === openChips[i]!.sourceFile
    )
  return enabled && unresolvedCount === 0 && chipsInSync
}
