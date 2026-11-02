import { Fragment, Suspense, lazy } from 'react'

/** A single reorderable row: a stable id plus the already-rendered row node. */
export interface KvTableRow {
  id: string
  node: React.ReactNode
}

interface KvTableProps {
  /** The rows, each keyed by a stable id used for drag reordering. */
  rows: KvTableRow[]
  /**
   * Called with the full id list in its new order after a drag-drop. When omitted
   * (or `readOnly`, or fewer than two rows) the table renders statically and the
   * drag machinery is never loaded.
   */
  onReorder?: (ids: string[]) => void
  readOnly?: boolean
  /** Non-row content rendered before the rows, outside the sortable area (e.g. a datalist). */
  prefix?: React.ReactNode
  /** Optional footer rendered below the rows (e.g. "Add row" CTAs). */
  footer?: React.ReactNode
}

// dnd-kit lives behind a lazy import so it is code-split out of the initial bundle
// (REQ-0079): the chunk is fetched only when a reorderable table first mounts.
const SortableRows = lazy(() => import('../ui/SortableRows'))

function StaticRows({ rows }: { rows: KvTableRow[] }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {rows.map((row) => (
        <Fragment key={row.id}>{row.node}</Fragment>
      ))}
    </div>
  )
}

export function KvTable({
  rows,
  onReorder,
  readOnly = false,
  prefix,
  footer
}: KvTableProps): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {prefix}
      {onReorder && !readOnly && rows.length > 1 ? (
        <Suspense fallback={<StaticRows rows={rows} />}>
          <SortableRows rows={rows} onReorder={onReorder} />
        </Suspense>
      ) : (
        <StaticRows rows={rows} />
      )}
      {footer}
    </div>
  )
}
