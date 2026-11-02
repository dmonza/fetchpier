import { createContext, useContext } from 'react'
import type { CSSProperties } from 'react'

/**
 * Per-row drag wiring exposed to a sortable row without forcing the row component
 * to import the drag-and-drop library. The lazy {@link SortableRows} wrapper (the
 * only module that pulls in `@dnd-kit/*`) computes this from `useSortable` and
 * publishes it through the context; consumers read it via {@link useSortableRow}.
 *
 * Keeping this module dnd-kit-free is what lets `KvRow`, `EnvironmentManager`, and
 * other row renderers stay in the initial bundle while the drag machinery is
 * code-split into its own chunk, fetched on first use of a reorderable table.
 */
export interface SortableRowWiring {
  /** Attach to the row's root element. */
  setNodeRef: (element: HTMLElement | null) => void
  /** Transform/transition style for the row while sorting. Apply to the root. */
  style: CSSProperties
  /** ARIA + activator attributes. Spread on the drag handle. */
  attributes: Record<string, unknown>
  /** Pointer/keyboard listeners. Spread on the drag handle. */
  listeners: Record<string, unknown> | undefined
  /** True while this row is the one being dragged. */
  isDragging: boolean
}

export const SortableRowContext = createContext<SortableRowWiring | null>(null)

/** The drag wiring for the current row, or `null` when not inside a sortable list. */
export function useSortableRow(): SortableRowWiring | null {
  return useContext(SortableRowContext)
}

/**
 * Reapply a new id order to a data array keyed by `getId`. Items whose id is not in
 * `newIds` are dropped; unknown ids are skipped. Used by editors to map the id order
 * emitted on drop back onto their typed rows.
 */
export function applyOrder<T>(items: T[], newIds: string[], getId: (item: T) => string): T[] {
  const byId = new Map(items.map((item) => [getId(item), item]))
  const out: T[] = []
  for (const id of newIds) {
    const item = byId.get(id)
    if (item !== undefined) out.push(item)
  }
  return out
}
