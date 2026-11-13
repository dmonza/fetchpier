import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, X, AlertTriangle } from 'lucide-react'
import { Button } from '../ui/button'
import { StagedFilePicker } from './StagedFilePicker'
import type { BinaryFileAttachment } from '../../../shared/types'

interface BinaryBodyPickerProps {
  binaryFile: BinaryFileAttachment | undefined
  /** Path of the currently-open workspace, or `null` when none is open. */
  workspacePath: string | null
  onChange: (next: BinaryFileAttachment | undefined) => void
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

export function BinaryBodyPicker({
  binaryFile,
  workspacePath,
  onChange,
  readOnly = false
}: BinaryBodyPickerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [statResult, setStatResult] = useState<{ exists: boolean; sizeBytes?: number } | null>(null)

  // When the picker mounts (or workspace/ref change) and we have a ref, check
  // whether the file actually exists on disk and look up its real size. The
  // parser fills in sizeBytes=0; statting refreshes it.
  useEffect(() => {
    if (!binaryFile?.ref || !workspacePath) {
      return
    }
    let cancelled = false
    void window.api.binary
      .stat({ ref: binaryFile.ref })
      .then((res) => {
        if (!cancelled) setStatResult(res)
      })
      .catch((err) => {
        console.error('[BinaryBodyPicker] stat failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [binaryFile?.ref, workspacePath])

  // Reset the stat result whenever the ref changes — derived from props so we
  // don't need a setState-in-effect for the sync part of the reset.
  const currentRef = binaryFile?.ref
  const [trackedRef, setTrackedRef] = useState<string | undefined>(currentRef)
  if (trackedRef !== currentRef) {
    setTrackedRef(currentRef)
    setStatResult(null)
  }

  const missing = statResult ? !statResult.exists : false
  const displaySize = statResult?.sizeBytes ?? binaryFile?.sizeBytes ?? null

  const stage = useCallback(
    async (sourcePath?: string, confirmed?: boolean): Promise<void> => {
      if (!workspacePath) return
      setError(null)
      try {
        // Loop instead of recursing — the only re-entry is "user confirmed,
        // retry with confirmed=true" which is one extra round-trip at most.
        let nextSourcePath: string | undefined = sourcePath
        let nextConfirmed: boolean | undefined = confirmed
        for (;;) {
          const result = await window.api.binary.selectAndStage({
            sourcePath: nextSourcePath,
            confirmed: nextConfirmed,
            title: t('request.body.binary.pickerTitle')
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
          // status === 'staged'
          setStatResult({ exists: true, sizeBytes: result.sizeBytes })
          onChange({
            ref: result.ref,
            originalName: result.originalName,
            sizeBytes: result.sizeBytes,
            mimeType: result.mimeType
          })
          return
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(t('request.body.binary.errorReadingFile', { message }))
      }
    },
    [workspacePath, t, onChange]
  )

  const handleChoose = useCallback(() => {
    void stage()
  }, [stage])

  const handlePickStaged = useCallback(
    (file: BinaryFileAttachment) => {
      setError(null)
      setStatResult({ exists: true, sizeBytes: file.sizeBytes })
      onChange(file)
    },
    [onChange]
  )

  const handleRemove = useCallback(() => {
    setError(null)
    setStatResult(null)
    onChange(undefined)
  }, [onChange])

  if (!binaryFile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <StagedFilePicker
          workspacePath={workspacePath}
          onPick={handlePickStaged}
          onStageNew={handleChoose}
          readOnly={readOnly || !workspacePath}
          trigger={(triggerProps) => (
            <Button
              {...triggerProps}
              type="button"
              variant="default"
              disabled={readOnly || !workspacePath}
            >
              <FileUp className="mr-2 h-4 w-4" />
              {t('request.body.binary.chooseFile')}
            </Button>
          )}
        />
        {!workspacePath && (
          <p className="text-xs text-muted-foreground">{t('request.body.binary.noFileSelected')}</p>
        )}
        {error && (
          <p className="max-w-md text-center text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  const sizeForDisplay = displaySize ?? binaryFile.sizeBytes ?? 0

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {binaryFile.originalName}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {t('request.body.binary.fileInfo', {
                name: binaryFile.originalName,
                size: humanizeBytes(sizeForDisplay),
                mime: binaryFile.mimeType
              })}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StagedFilePicker
              workspacePath={workspacePath}
              onPick={handlePickStaged}
              onStageNew={handleChoose}
              readOnly={readOnly || !workspacePath}
              trigger={(triggerProps) => (
                <Button
                  {...triggerProps}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={readOnly || !workspacePath}
                >
                  {t('request.body.binary.replace')}
                </Button>
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={readOnly}
              aria-label={t('request.body.binary.remove')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      {missing && (
        <div
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('request.body.binary.fileMissing', { ref: binaryFile.ref })}</span>
        </div>
      )}
      {error && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  )
}
