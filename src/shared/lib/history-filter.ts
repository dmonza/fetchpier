// The History panel's request filter, as one rule shared by the disk listing
// (`@fetchpier/core` `history.list`) and the renderer's in-flight filtering.
//
// A run belongs to a filtered request when its recorded request id is one of
// `requestIds`, or — the last-resort fallback for a file with no `# @id`, whose
// sends each recorded a session-random id — when its `@source-file` is one of
// `sourceFiles` **and** it recorded a request id. Only desktop sends record a
// request id, and the desktop sends a file's first request (the one its tab
// shows); a CLI run records none and may be any request of a multi-request
// file, so it is left out of the path match, as it is of the id match.

export interface HistoryRequestFilter {
  requestIds?: readonly string[]
  /** Workspace-relative `.http` paths; either separator style. */
  sourceFiles?: readonly string[]
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/')
}

/** True when the filter selects anything (an empty list is no filter). */
export function hasHistoryRequestFilter(filter: HistoryRequestFilter): boolean {
  return (filter.requestIds?.length ?? 0) > 0 || (filter.sourceFiles?.length ?? 0) > 0
}

/**
 * Build a reusable matcher for `filter`. With no ids and no paths it keeps
 * every run.
 */
export function historyEntryMatcher(
  filter: HistoryRequestFilter
): (entry: { requestId?: string; sourceFile: string | null }) => boolean {
  if (!hasHistoryRequestFilter(filter)) return () => true
  const ids = new Set(filter.requestIds ?? [])
  const paths = new Set((filter.sourceFiles ?? []).map(normalizeSeparators))
  return (entry) => {
    if (entry.requestId === undefined) return false
    if (ids.has(entry.requestId)) return true
    return entry.sourceFile !== null && paths.has(normalizeSeparators(entry.sourceFile))
  }
}

export function historyEntryMatchesFilter(
  entry: { requestId?: string; sourceFile: string | null },
  filter: HistoryRequestFilter
): boolean {
  return historyEntryMatcher(filter)(entry)
}
