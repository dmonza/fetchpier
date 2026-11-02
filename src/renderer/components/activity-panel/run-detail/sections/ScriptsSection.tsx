// Renders the Scripts section of an expanded run row (REQ-0069 §6.2).
//
// One subsection per phase (Pre-request / Post-response) that produced
// content. The heading shows the phase summary straight from the
// `@script-pre` / `@script-post` directive value (e.g. "failed (2 passed, 1
// failed)"). Each line is rendered in source order — REQ §10 Q2 (a) — using
// the dedicated `parseScriptResultEntries` helper that preserves emission
// order, unlike `parseScriptResultLines` (which sorts into separate arrays).
//
// If neither phase has a `@script-results` tail block, the section returns
// `null` — `RunDetail` will not mount it (matches CA-06).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  XCircle
} from 'lucide-react'
import {
  parseScriptResultEntries,
  type ActivityLogFile,
  type ScriptResultEntry
} from '../../../../../shared/lib/activity-log'
import type { ScriptsSectionSpec } from '../types'

interface Props {
  file: ActivityLogFile
  spec: ScriptsSectionSpec
}

interface PhaseData {
  /** i18n label key for the phase heading. */
  labelKey: string
  /** Summary string from the matching `@script-pre`/`@script-post` directive. */
  summary: string | null
  /** Block lines in source order. */
  lines: string[]
}

function findDirective(file: ActivityLogFile, key: string): string | null {
  for (const it of file.header) {
    if (it.kind === 'directive' && it.key === key) return it.value
  }
  return null
}

function findTailBlock(file: ActivityLogFile, fullName: string): string[] | null {
  for (const b of file.tailBlocks) {
    if (b.name === fullName) return b.lines
  }
  return null
}

export function shouldRenderScripts(file: ActivityLogFile): boolean {
  return (
    findTailBlock(file, 'script-results: pre-request') !== null ||
    findTailBlock(file, 'script-results: post-response') !== null
  )
}

function logIcon(level: 'log' | 'warn' | 'error'): React.JSX.Element {
  if (level === 'warn') return <AlertTriangle className="h-3 w-3 text-warning-text" />
  if (level === 'error') return <AlertCircle className="h-3 w-3 text-danger-text" />
  return <Info className="h-3 w-3 text-muted-foreground" />
}

function logTextClass(level: 'log' | 'warn' | 'error'): string {
  if (level === 'warn') return 'text-warning-text'
  if (level === 'error') return 'text-danger-text'
  return 'text-foreground'
}

function EntryItem({ entry }: { entry: ScriptResultEntry }): React.JSX.Element {
  if (entry.kind === 'log') {
    return (
      <li className="flex items-start gap-1.5 py-0.5">
        <span className="mt-0.5 shrink-0">{logIcon(entry.level)}</span>
        <span
          className={`whitespace-pre-wrap break-words text-[11px] ${logTextClass(entry.level)}`}
        >
          {entry.text}
        </span>
      </li>
    )
  }
  if (entry.kind === 'test' && entry.passed) {
    return (
      <li className="flex items-start gap-1.5 py-0.5">
        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success-text" />
        <span className="text-[11px] text-foreground">{entry.name}</span>
      </li>
    )
  }
  if (entry.kind === 'test') {
    return (
      <li className="flex items-start gap-1.5 py-0.5">
        <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-danger-text" />
        <span className="text-[11px]">
          <span className="font-medium text-foreground">{entry.name}</span>
          {entry.message && (
            <>
              {' — '}
              <span className="text-danger-text">{entry.message}</span>
            </>
          )}
        </span>
      </li>
    )
  }
  // error
  return (
    <li className="flex items-start gap-1.5 py-0.5">
      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-danger-text" />
      <span className="whitespace-pre-wrap break-words text-[11px] text-danger-text">
        {entry.stack ?? entry.message}
      </span>
    </li>
  )
}

export function ScriptsSection({ file, spec }: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)

  const phases: PhaseData[] = []
  const preLines = findTailBlock(file, 'script-results: pre-request')
  if (preLines) {
    phases.push({
      labelKey: 'history.expansion.scripts.preRequest',
      summary: findDirective(file, 'script-pre'),
      lines: preLines
    })
  }
  const postLines = findTailBlock(file, 'script-results: post-response')
  if (postLines) {
    phases.push({
      labelKey: 'history.expansion.scripts.postResponse',
      summary: findDirective(file, 'script-post'),
      lines: postLines
    })
  }

  if (phases.length === 0) return null

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
          {t(spec.titleKey ?? 'history.expansion.scripts.title')}
        </h4>
      </button>
      {isOpen && (
        <div className="px-3 pb-2">
          {phases.map((phase) => {
            const entries = parseScriptResultEntries(phase.lines)
            return (
              <div key={phase.labelKey} className="mt-1 first:mt-0">
                <div className="mb-0.5 flex items-baseline gap-2 text-[11px]">
                  <span className="font-medium text-foreground">{t(phase.labelKey)}</span>
                  {phase.summary && <span className="text-muted-foreground">{phase.summary}</span>}
                </div>
                <ul className="pl-1">
                  {entries.map((e, i) => (
                    <EntryItem key={i} entry={e} />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
