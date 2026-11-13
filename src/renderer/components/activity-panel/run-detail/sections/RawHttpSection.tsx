// Renders one half of an HTTP exchange (request OR response) as the raw bytes
// stored in the `.http` activity log — a monospace box (CodeMirror, read-only)
// over `requestRaw`/`responseRaw` (REQ-0069 §6.2).
//
// When the section is configured with `jsonFormatToggle: true` AND the
// payload's `Content-Type` is JSON (`application/json` or any `+json` type,
// parameters ignored), a `[Format]/[Raw]`
// button toggles a local state and pretty-prints the **body** only, leaving
// the request/status line and headers untouched. Per-row local state — no
// store involvement, never persisted (REQ §6.2).
//
// Binary bodies are already rendered as the `[binary body, …]` placeholder
// line by the serializer; we render whatever bytes are there, unchanged.

import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlignLeft, ChevronDown, ChevronRight, Code } from 'lucide-react'
import { useCodeMirror } from '../../../../hooks/useCodeMirror'
import { prettyPrintJson } from '../../../../lib/format-body'
import type { ActivityLogFile } from '../../../../../shared/lib/activity-log'
import type { RawHttpSectionSpec } from '../types'

interface Props {
  file: ActivityLogFile
  spec: RawHttpSectionSpec
}

function splitHttpBlock(raw: string): { head: string; body: string; sep: string } {
  // Headers and body are separated by a blank line. We preserve whichever line
  // terminator the serializer used so toggle does not change the file shape.
  const idx = raw.indexOf('\r\n\r\n')
  if (idx >= 0) {
    return { head: raw.slice(0, idx), sep: '\r\n\r\n', body: raw.slice(idx + 4) }
  }
  const idx2 = raw.indexOf('\n\n')
  if (idx2 >= 0) {
    return { head: raw.slice(0, idx2), sep: '\n\n', body: raw.slice(idx2 + 2) }
  }
  return { head: raw, sep: '', body: '' }
}

function getHeader(head: string, name: string): string | null {
  const lower = name.toLowerCase()
  const lines = head.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const colon = line.indexOf(':')
    if (colon < 0) continue
    if (line.slice(0, colon).trim().toLowerCase() === lower) {
      return line.slice(colon + 1).trim()
    }
  }
  return null
}

/**
 * `application/json`, or any RFC 6839 `+json` structured-syntax type
 * (`application/problem+json`, `application/vnd.api+json`, …). Parameters
 * after `;` are ignored, the comparison is case-insensitive.
 */
function isJsonMediaType(contentType: string): boolean {
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

function ReadOnlyMonospace({ value }: { value: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useCodeMirror(ref, { value, language: 'text', onChange: () => {}, readOnly: true })
  return <div ref={ref} className="h-full w-full" />
}

export function RawHttpSection({ file, spec }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const raw = spec.which === 'request' ? file.requestRaw : file.responseRaw
  const { head, body, sep } = useMemo(() => splitHttpBlock(raw), [raw])
  const contentType = useMemo(() => getHeader(head, 'content-type') ?? '', [head])
  const isJson = isJsonMediaType(contentType)
  const canFormat = Boolean(spec.jsonFormatToggle) && isJson

  const [isOpen, setIsOpen] = useState(false)
  const [isFormatted, setIsFormatted] = useState(false)
  const display = useMemo(() => {
    if (!isFormatted || !canFormat) return raw
    const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body
    const formattedBody = prettyPrintJson(trimmed)
    const trailing = body.endsWith('\n') ? '\n' : ''
    return head + sep + formattedBody + trailing
  }, [isFormatted, canFormat, raw, head, body, sep])

  const defaultTitleKey =
    spec.which === 'request'
      ? 'history.expansion.request.title'
      : 'history.expansion.response.title'

  return (
    <section className="flex flex-col border-b border-border">
      <div className="flex items-center justify-between px-3 py-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setIsOpen((v) => !v)
          }}
          aria-expanded={isOpen}
          className="flex flex-1 items-center gap-1 text-left hover:bg-accent/50"
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t(spec.titleKey ?? defaultTitleKey)}
          </h4>
        </button>
        {isOpen && canFormat && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setIsFormatted((v) => !v)
            }}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={t(
              isFormatted ? 'history.expansion.response.raw' : 'history.expansion.response.format'
            )}
          >
            {isFormatted ? <AlignLeft className="h-3 w-3" /> : <Code className="h-3 w-3" />}
            {t(
              isFormatted ? 'history.expansion.response.raw' : 'history.expansion.response.format'
            )}
          </button>
        )}
      </div>
      {isOpen && (
        <div className="h-64 border-t border-border">
          <ReadOnlyMonospace value={display} />
        </div>
      )}
    </section>
  )
}
