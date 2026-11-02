import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { FileUp, Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import { fuzzyMatch } from '../../lib/fuzzy'
import type { BinaryFileAttachment, StagedBinaryEntry } from '../../../shared/types'

export interface StagedFilePickerTriggerProps {
  onClick: (e: React.MouseEvent) => void
  'aria-haspopup': 'listbox'
  'aria-expanded': boolean
}

interface StagedFilePickerProps {
  /** Workspace where staged files live. When `null`, the picker only shows
   *  "Select local file…" with an empty list and disables the search. */
  workspacePath: string | null
  /** Renders the trigger element. The picker injects the click handler and
   *  aria attributes; the caller styles the button to fit its layout. */
  trigger: (props: StagedFilePickerTriggerProps) => React.ReactElement
  /** Called when the user selects an already-staged file from the list. */
  onPick: (file: BinaryFileAttachment) => void
  /** Called when the user clicks "Select local file…" — the consumer runs its
   *  own selectAndStage flow (so each call site keeps its confirmation +
   *  error UI). */
  onStageNew: () => void
  /** When true, the trigger is rendered as-is and clicks do nothing. */
  readOnly?: boolean
  /** Optional aria-label for the dropdown panel. */
  ariaLabel?: string
  /** Layout class applied to the wrapper. Defaults to `relative inline-block`. */
  wrapperClassName?: string
}

const PANEL_WIDTH_PX = 288 // matches w-72

function humanizeBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

export function StagedFilePicker({
  workspacePath,
  trigger,
  onPick,
  onStageNew,
  readOnly = false,
  ariaLabel,
  wrapperClassName
}: StagedFilePickerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<StagedBinaryEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const closePanel = useCallback(() => {
    setOpen(false)
    setQuery('')
    setSelectedIndex(0)
    setEntries(null)
    setPanelPos(null)
  }, [])

  const openPanel = useCallback(() => {
    setOpen(true)
    if (!workspacePath) {
      setEntries([])
      return
    }
    void window.api.binary
      .list()
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [workspacePath])

  // Focus the search input whenever the panel opens.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Position the floating panel relative to the trigger. The panel renders
  // through a portal so it can escape any parent stacking context — without
  // that, response/sidebar panels would draw on top of it. We re-anchor on
  // open and close on scroll/resize to avoid the panel drifting away from
  // the trigger as the layout changes.
  useEffect(() => {
    if (!open) return
    const compute = (): void => {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (!rect) return
      const maxLeft = window.innerWidth - PANEL_WIDTH_PX - 8
      const left = Math.max(8, Math.min(rect.left, maxLeft))
      setPanelPos({ top: rect.bottom + 4, left })
    }
    compute()
    const onChange = (): void => closePanel()
    window.addEventListener('scroll', onChange, true)
    window.addEventListener('resize', onChange)
    return () => {
      window.removeEventListener('scroll', onChange, true)
      window.removeEventListener('resize', onChange)
    }
  }, [open, closePanel])

  // Close on outside click + ESC while the panel is open. The panel is in a
  // portal, so the check has to cover both the wrapper and the panel itself.
  useEffect(() => {
    if (!open) return
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (wrapperRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      closePanel()
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePanel()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, closePanel])

  const filtered = (entries ?? []).filter((e) => fuzzyMatch(e.originalName, query))
  const safeIndex = filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1)

  const pick = useCallback(
    (entry: StagedBinaryEntry) => {
      onPick({
        ref: entry.ref,
        originalName: entry.originalName,
        sizeBytes: entry.sizeBytes,
        mimeType: entry.mimeType
      })
      closePanel()
    },
    [onPick, closePanel]
  )

  const handleStageNew = useCallback(() => {
    closePanel()
    onStageNew()
  }, [onStageNew, closePanel])

  const handleSearchKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((p) => Math.min(p + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((p) => Math.max(p - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = filtered[safeIndex]
      if (entry) pick(entry)
    }
  }

  const handleTriggerClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (readOnly) return
      if (open) closePanel()
      else openPanel()
    },
    [readOnly, open, closePanel, openPanel]
  )

  const panel =
    open && panelPos ? (
      <div
        ref={panelRef}
        role="dialog"
        aria-label={ariaLabel ?? t('request.body.binary.picker.openLabel')}
        style={{ position: 'fixed', top: panelPos.top, left: panelPos.left, width: PANEL_WIDTH_PX }}
        className="z-[1000] max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('request.body.binary.picker.searchPlaceholder')}
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            aria-label={t('request.body.binary.picker.searchPlaceholder')}
          />
        </div>

        {/* List — ~10 rows visible (28px each), scroll for more */}
        <div className="max-h-72 overflow-y-auto py-1" role="listbox">
          {entries === null ? null : filtered.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {t('request.body.binary.picker.empty')}
            </p>
          ) : (
            filtered.map((entry, idx) => (
              <button
                key={entry.ref}
                type="button"
                role="option"
                aria-selected={idx === safeIndex}
                onMouseEnter={() => setSelectedIndex(idx)}
                onClick={() => pick(entry)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1 text-left text-xs',
                  idx === safeIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{entry.originalName}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {humanizeBytes(entry.sizeBytes)}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer — always present */}
        <button
          type="button"
          onClick={handleStageNew}
          className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
        >
          <FileUp className="h-3.5 w-3.5 shrink-0" />
          {t('request.body.binary.picker.selectLocal')}
        </button>
      </div>
    ) : null

  return (
    <div ref={wrapperRef} className={cn('relative inline-block', wrapperClassName)}>
      {trigger({
        onClick: handleTriggerClick,
        'aria-haspopup': 'listbox',
        'aria-expanded': open
      })}
      {panel && createPortal(panel, document.body)}
    </div>
  )
}
