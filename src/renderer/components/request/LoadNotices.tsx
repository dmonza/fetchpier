import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { RequestEditorState } from '../../../shared/types'

interface LoadNoticesProps {
  request: Pick<RequestEditorState, 'bodyType' | 'binaryFile' | 'invalidBinaryRef'>
  /** The edited request's load warnings (`Tab.loadWarnings`). */
  loadWarnings?: string[]
  /** The file loaded with no readable request (`Tab.unreadableOnLoad`). */
  unreadable?: boolean
}

/**
 * What the file said that the editor could not take as written, shown when the
 * request opens:
 * - **Load warnings** — content a save will drop or rewrite (a malformed
 *   `# @auth` block, an invalid `# @settings` entry, …). A localized heading,
 *   then the parser's own technical messages. The tab is modified for the same
 *   reason (`computeTabDirty`).
 * - **An invalid binary reference** — kept on save, but the request is refused
 *   until a file is attached again. Shown while binary mode has no valid file.
 * - **A file with no readable request** — the editor holds none of its content,
 *   so a save is refused rather than overwrite it. Shown until a load reads it.
 */
export function LoadNotices({
  request,
  loadWarnings,
  unreadable
}: LoadNoticesProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const pendingRef =
    request.bodyType === 'binary' && !request.binaryFile?.ref ? request.invalidBinaryRef : undefined
  const hasWarnings = loadWarnings !== undefined && loadWarnings.length > 0
  if (!hasWarnings && pendingRef === undefined && !unreadable) return null

  return (
    <>
      {unreadable && (
        <div
          data-notice="unreadable-file"
          role="status"
          className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{t('request.unreadableFile.title')}</p>
            <p className="text-destructive/90">{t('request.unreadableFile.detail')}</p>
          </div>
        </div>
      )}
      {hasWarnings && (
        <div
          data-notice="load-warnings"
          className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{t('request.loadWarnings.title')}</p>
            <p className="text-destructive/90">{t('request.loadWarnings.detail')}</p>
            <ul className="list-disc space-y-0.5 pl-4 font-mono text-[11px] text-destructive/90">
              {loadWarnings.map((w, i) => (
                <li key={i} className="break-words">
                  {w}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {pendingRef !== undefined && (
        <div
          data-notice="invalid-binary-ref"
          role="status"
          className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text shrink-0"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{t('request.invalidBinaryRef.title')}</p>
            <p className="break-words">
              {t('request.invalidBinaryRef.detail', { ref: pendingRef })}
            </p>
          </div>
        </div>
      )}
    </>
  )
}
