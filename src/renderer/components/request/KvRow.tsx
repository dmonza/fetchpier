import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, GripVertical, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useSortableRow } from '../ui/sortable-context'

interface KvRowProps {
  enabled: boolean
  onToggleEnabled?: () => void
  onRemove?: () => void
  /** When true, all interactive controls are disabled and drag/expand/delete are hidden. */
  readOnly?: boolean
  /** Expand controls. The toggle button renders only when `expandable` is true. */
  expandable?: boolean
  expanded?: boolean
  onToggleExpanded?: () => void
  /** Optional sub-row revealed when `expanded` is true. */
  expandedContent?: React.ReactNode
  /** Always-visible footer (e.g. for errors and warnings). */
  rowFooter?: React.ReactNode
  /** Leading slot after the drag handle (rarely needed). */
  leading?: React.ReactNode
  /** The row's main cells (key, value, dropdowns, etc.). */
  children?: React.ReactNode
  /** Optional aria-label override for the enable checkbox. */
  toggleEnabledLabel?: string
}

/**
 * A single key-value row. Reordering is provided by the surrounding
 * {@link SortableRows} (drag & drop, REQ-0079): when this row is inside a sortable
 * list it reads its drag wiring from {@link useSortableRow} and renders a drag
 * handle. Outside a sortable list (read-only views, single-row tables) no handle
 * shows and the row renders statically.
 */
export function KvRow({
  enabled,
  onToggleEnabled,
  onRemove,
  readOnly = false,
  expandable = false,
  expanded = false,
  onToggleExpanded,
  expandedContent,
  rowFooter,
  leading,
  children,
  toggleEnabledLabel
}: KvRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const sortable = useSortableRow()
  const showDrag = !readOnly && sortable !== null
  const showExpand = !readOnly && expandable
  const showDelete = !readOnly && onRemove !== undefined

  return (
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      className={cn(
        'group border-b border-border',
        !enabled && 'opacity-60',
        sortable?.isDragging && 'bg-surface-2 shadow-sm'
      )}
    >
      <div className="flex items-center gap-1 px-2 py-1">
        {showDrag && (
          <button
            type="button"
            className="flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground opacity-30 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
            aria-label={t('keyValue.dragHandle')}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}

        {leading}

        <input
          type="checkbox"
          checked={enabled}
          onChange={() => !readOnly && onToggleEnabled?.()}
          disabled={readOnly}
          className="h-3.5 w-3.5 shrink-0 accent-primary"
          aria-label={toggleEnabledLabel ?? t('keyValue.toggleEnabled')}
        />

        {children}

        {showExpand && (
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-label={expanded ? t('keyValue.collapse') : t('keyValue.expand')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-30 transition-opacity hover:text-foreground hover:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        )}

        {showDelete && (
          <button
            type="button"
            onClick={onRemove}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-30 transition-opacity hover:text-destructive hover:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={t('keyValue.remove')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {expanded && expandedContent && (
        <div className="flex flex-col gap-2 pb-2 pl-9 pr-3">{expandedContent}</div>
      )}

      {rowFooter && <div className="flex flex-col gap-1 pb-2 pl-9 pr-3">{rowFooter}</div>}
    </div>
  )
}
