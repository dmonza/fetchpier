// Renders the Metadata key/value table for an expanded run row (REQ-0069).
//
// The component knows nothing about specific directives or domains: each row
// is supplied by the descriptor via `pick(file)`. If a row's pick returns
// null, the row is omitted (matches REQ §6.2 "Rows whose source directive is
// absent in a given run are simply omitted").
//
// When `includeSettingsBlock` is set, the `@settings` header block is
// expanded inline as additional rows (one per key) — REQ §2.2 / §8 keep
// settings in v1 as Metadata rows rather than a dedicated section.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import type { ActivityLogFile } from '../../../../../shared/lib/activity-log'
import type { MetadataRowSpec, MetadataSectionSpec } from '../types'

interface Props {
  file: ActivityLogFile
  spec: MetadataSectionSpec
  onOpenSourceFile?: (relativePath: string) => void
}

function findSettingsBlock(file: ActivityLogFile): string[] | null {
  for (const it of file.header) {
    if (it.kind === 'block' && it.name === 'settings') return it.lines
  }
  return null
}

function parseSettingsLines(lines: string[]): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key) out.push({ key, value })
  }
  return out
}

function MetadataRow({
  row,
  file,
  onOpenSourceFile
}: {
  row: MetadataRowSpec
  file: ActivityLogFile
  onOpenSourceFile?: (path: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const value = row.pick(file)
  if (value === null) return null

  if (row.variant === 'path-with-open' && onOpenSourceFile) {
    return (
      <div className="flex items-baseline gap-2 py-0.5">
        <span className="w-28 shrink-0 text-[11px] text-muted-foreground">{t(row.labelKey)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={value}>
          {value}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenSourceFile(value)
          }}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title={t('history.expansion.metadata.openFile')}
        >
          <ExternalLink className="h-3 w-3" />
          {t('history.expansion.metadata.openFile')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-28 shrink-0 text-[11px] text-muted-foreground">{t(row.labelKey)}</span>
      <span className="min-w-0 flex-1 truncate text-[11px]" title={value}>
        {value}
      </span>
    </div>
  )
}

export function MetadataSection({ file, spec, onOpenSourceFile }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const settingsRows = spec.includeSettingsBlock
    ? parseSettingsLines(findSettingsBlock(file) ?? [])
    : []

  return (
    <section className="border-b border-border">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setIsOpen((v) => !v)
        }}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1 px-3 py-1 text-left hover:bg-accent/50"
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t(spec.titleKey ?? 'history.expansion.metadata.title')}
        </h4>
      </button>
      {isOpen && (
        <div className="px-3 pb-2">
          {spec.rows.map((row) => (
            <MetadataRow key={row.id} row={row} file={file} onOpenSourceFile={onOpenSourceFile} />
          ))}
          {settingsRows.length > 0 && (
            <div className="mt-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setIsSettingsOpen((v) => !v)
                }}
                aria-expanded={isSettingsOpen}
                className="flex w-full items-center gap-1 py-0.5 text-left hover:bg-accent/50"
              >
                {isSettingsOpen ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('history.expansion.metadata.settings')}
                </span>
              </button>
              {isSettingsOpen && (
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 pl-4">
                  {settingsRows.map((s) => (
                    <div key={`setting-${s.key}`} className="contents">
                      <span className="py-0.5 text-[11px] text-muted-foreground" title={s.key}>
                        {s.key}
                      </span>
                      <span
                        className="min-w-0 truncate py-0.5 font-mono text-[11px]"
                        title={s.value}
                      >
                        {s.value}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
