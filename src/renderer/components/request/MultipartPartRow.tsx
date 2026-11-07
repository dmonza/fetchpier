import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, FileUp, AlertTriangle } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { KvRow } from './KvRow'
import { StagedFilePicker } from './StagedFilePicker'
import type {
  BinaryFileAttachment,
  MultipartPart,
  MultipartFilePart,
  MultipartTextPart
} from '../../../shared/types'

interface MultipartPartRowProps {
  part: MultipartPart
  workspacePath: string | null
  onChange: (next: MultipartPart) => void
  onRemove: () => void
  readOnly?: boolean
}

function humanizeBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function bytesToMb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1)
}

// Convert a part to a different kind, preserving id/name/disabled/contentType.
function switchKind(part: MultipartPart, kind: 'text' | 'file'): MultipartPart {
  if (part.kind === kind) return part
  if (kind === 'text') {
    const next: MultipartTextPart = {
      kind: 'text',
      id: part.id,
      name: part.name,
      value: '',
      disabled: part.disabled,
      contentType: part.contentType
    }
    return next
  }
  const next: MultipartFilePart = {
    kind: 'file',
    id: part.id,
    name: part.name,
    file: { ref: '', originalName: '', sizeBytes: 0, mimeType: '' },
    disabled: part.disabled,
    contentType: part.contentType
  }
  return next
}

export function MultipartPartRow({
  part,
  workspacePath,
  onChange,
  onRemove,
  readOnly = false
}: MultipartPartRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [statResult, setStatResult] = useState<{ exists: boolean; sizeBytes?: number } | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fileRef = part.kind === 'file' ? part.file.ref : undefined
  const [trackedRef, setTrackedRef] = useState<string | undefined>(fileRef)
  if (trackedRef !== fileRef) {
    setTrackedRef(fileRef)
    setStatResult(null)
  }
  useEffect(() => {
    if (!fileRef || !workspacePath) return
    let cancelled = false
    void window.api.binary
      .stat({ ref: fileRef })
      .then((res) => {
        if (!cancelled) setStatResult(res)
      })
      .catch(() => {
        // Ignore stat errors; we'll just show what we have.
      })
    return () => {
      cancelled = true
    }
  }, [fileRef, workspacePath])

  const handlePickStaged = useCallback(
    (file: BinaryFileAttachment) => {
      if (part.kind !== 'file') return
      setError(null)
      setStatResult({ exists: true, sizeBytes: file.sizeBytes })
      onChange({ ...part, file })
    },
    [part, onChange]
  )

  const handlePickFile = useCallback(async () => {
    if (!workspacePath || readOnly) return
    setError(null)
    try {
      let nextConfirmed: boolean | undefined
      let nextSourcePath: string | undefined
      for (;;) {
        const result = await window.api.binary.selectAndStage({
          sourcePath: nextSourcePath,
          confirmed: nextConfirmed
        })
        if (result.status === 'cancelled') return
        if (result.status === 'blocked') {
          setError(
            t('request.body.binary.tooLargeBlock', {
              sizeMB: bytesToMb(result.sizeBytes),
              limitMB: bytesToMb(result.blockBytes)
            })
          )
          return
        }
        if (result.status === 'requiresConfirmation') {
          const proceed = window.confirm(
            `${t('request.body.binary.confirmTitle')}\n\n` +
              t('request.body.binary.confirmMessage', {
                sizeMB: bytesToMb(result.sizeBytes),
                warnMB: bytesToMb(result.warnBytes)
              })
          )
          if (!proceed) return
          nextSourcePath = result.sourcePath
          nextConfirmed = true
          continue
        }
        if (part.kind === 'file') {
          const next: MultipartFilePart = {
            ...part,
            file: {
              ref: result.ref,
              originalName: result.originalName,
              sizeBytes: result.sizeBytes,
              mimeType: result.mimeType
            }
          }
          onChange(next)
        }
        return
      }
    } catch (err) {
      setError(t('request.body.binary.errorReadingFile', { message: String(err) }))
    }
  }, [workspacePath, readOnly, t, part, onChange])

  const missing = part.kind === 'file' && statResult ? !statResult.exists : false
  const displaySize = part.kind === 'file' ? (statResult?.sizeBytes ?? part.file.sizeBytes ?? 0) : 0
  const hasFooter = missing || (part.kind === 'file' && !!part.parseError) || !!error

  const inputClass =
    'h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 text-xs placeholder:text-muted-foreground focus:border-border focus:outline-none'

  const expandedContent = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1">
      {part.kind === 'file' && (
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t('request.body.multipart.filename')}:</span>
          <input
            type="text"
            value={part.filename ?? ''}
            onChange={(e) =>
              onChange({
                ...part,
                filename: e.target.value === '' ? undefined : e.target.value
              } as MultipartFilePart)
            }
            placeholder={t('request.body.multipart.filenamePlaceholder')}
            disabled={readOnly}
            className="rounded-md border border-border bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
      )}
      <label className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{t('request.body.multipart.contentType')}:</span>
        <input
          type="text"
          value={part.contentType ?? ''}
          onChange={(e) =>
            onChange({
              ...part,
              contentType: e.target.value === '' ? undefined : e.target.value
            })
          }
          placeholder={t('request.body.multipart.contentTypePlaceholder')}
          disabled={readOnly}
          className="rounded-md border border-border bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </label>
    </div>
  )

  const rowFooter = hasFooter ? (
    <>
      {part.kind === 'file' && missing && (
        <div
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning-text"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('request.body.multipart.fileMissing', { ref: part.file.ref })}</span>
        </div>
      )}
      {part.kind === 'file' && part.parseError && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          role="alert"
        >
          {t('request.body.multipart.parseError', { error: part.parseError })}
        </div>
      )}
      {error && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}
    </>
  ) : undefined

  return (
    <KvRow
      enabled={!part.disabled}
      onToggleEnabled={() => onChange({ ...part, disabled: part.disabled ? undefined : true })}
      onRemove={onRemove}
      expandable
      expanded={expanded}
      onToggleExpanded={() => setExpanded((v) => !v)}
      expandedContent={expandedContent}
      rowFooter={rowFooter}
      readOnly={readOnly}
      toggleEnabledLabel={t('request.body.multipart.disabled')}
    >
      <input
        type="text"
        value={part.name}
        onChange={(e) => onChange({ ...part, name: e.target.value })}
        placeholder={t('request.body.multipart.namePlaceholder')}
        disabled={readOnly}
        className={inputClass}
        aria-label={t('request.body.multipart.name')}
      />

      {/* Value + kind selector grouped as a single control: value flex-1 with
          rounded-r-none, selector glued to its right with rounded-l-none. */}
      <div className="flex min-w-0 flex-1 items-center">
        {part.kind === 'text' ? (
          <input
            type="text"
            value={part.value}
            onChange={(e) => onChange({ ...(part as MultipartTextPart), value: e.target.value })}
            placeholder={t('request.body.multipart.valuePlaceholder')}
            disabled={readOnly}
            className={cn(inputClass, 'rounded-r-none font-mono')}
            aria-label={t('request.body.multipart.value')}
          />
        ) : part.file.ref ? (
          <div className="flex h-7 min-w-0 flex-1 items-center gap-2 px-2">
            <FileUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {t('request.body.multipart.fileInfo', {
                name: part.file.originalName,
                size: humanizeBytes(displaySize)
              })}
            </span>
            <StagedFilePicker
              workspacePath={workspacePath}
              onPick={handlePickStaged}
              onStageNew={() => void handlePickFile()}
              readOnly={readOnly || !workspacePath}
              trigger={(triggerProps) => (
                <Button
                  {...triggerProps}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={readOnly || !workspacePath}
                  className="h-6 px-2 text-xs"
                >
                  {t('request.body.multipart.replaceFile')}
                </Button>
              )}
            />
          </div>
        ) : (
          <StagedFilePicker
            workspacePath={workspacePath}
            onPick={handlePickStaged}
            onStageNew={() => void handlePickFile()}
            readOnly={readOnly || !workspacePath}
            wrapperClassName="flex min-w-0 flex-1"
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly || !workspacePath}
                className="h-7 w-full justify-start rounded-r-none"
              >
                <FileUp className="mr-1.5 h-3.5 w-3.5" />
                {t('request.body.multipart.chooseFile')}
              </Button>
            )}
          />
        )}

        <div className="relative flex shrink-0 items-center">
          <select
            value={part.kind}
            onChange={(e) =>
              !readOnly && onChange(switchKind(part, e.target.value as 'text' | 'file'))
            }
            disabled={readOnly}
            aria-label={t('request.body.multipart.kindSelect')}
            className={cn(
              'h-7 appearance-none rounded-md rounded-l-none border border-border bg-background pl-2 pr-6 text-xs',
              'focus:outline-none focus:ring-1 focus:ring-ring',
              readOnly && 'cursor-default opacity-75'
            )}
          >
            <option value="text">{t('request.body.multipart.kindText')}</option>
            <option value="file">{t('request.body.multipart.kindFile')}</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" />
        </div>
      </div>
    </KvRow>
  )
}
