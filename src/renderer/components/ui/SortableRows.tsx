import type { ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { SortableRowContext } from './sortable-context'

/**
 * Lazy-loaded drag-and-drop wrapper for vertical row reordering. This is the ONLY
 * module that imports `@dnd-kit/*`; it is reached exclusively through
 * `React.lazy(() => import('./SortableRows'))`, so the library is code-split into
 * its own chunk and never enters the initial bundle (REQ-0079 §6, lazy-load).
 *
 * Each row is wrapped in a {@link SortableItem} that calls `useSortable` and
 * publishes the resulting wiring through {@link SortableRowContext}; the row
 * component renders its own drag handle by reading that context.
 */
export interface SortableRowsItem {
  id: string
  node: ReactNode
}

interface SortableRowsProps {
  rows: SortableRowsItem[]
  /** Called with the full id list in its new order after a drop. */
  onReorder: (ids: string[]) => void
}

export default function SortableRows({ rows, onReorder }: SortableRowsProps): React.JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const ids = rows.map((row) => row.id)

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    onReorder(arrayMove(ids, oldIndex, newIndex))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col">
          {rows.map((row) => (
            <SortableItem key={row.id} id={row.id}>
              {row.node}
            </SortableItem>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function SortableItem({ id, children }: { id: string; children: ReactNode }): React.JSX.Element {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id
  })
  return (
    <SortableRowContext.Provider
      value={{
        setNodeRef,
        style: {
          transform: CSS.Transform.toString(transform),
          transition,
          zIndex: isDragging ? 10 : undefined,
          position: isDragging ? 'relative' : undefined
        },
        attributes: attributes as unknown as Record<string, unknown>,
        listeners: listeners as unknown as Record<string, unknown> | undefined,
        isDragging
      }}
    >
      {children}
    </SortableRowContext.Provider>
  )
}
