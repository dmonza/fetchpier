import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, X } from 'lucide-react'
import type { ExecutionWarning } from '../../../shared/types'

/**
 * The advisories shown as a dismissible notice in the response area: the ones
 * about the send itself that would otherwise only have reached a log — the cookie
 * jar or TLS material could not be used, HTTP/2 was downgraded, a Content-Type
 * was replaced, a script write could not be saved. Cookie advisories belong to
 * the Cookies section, decoding ones to the size indicator, and variable / query
 * ones to the editor; they are deliberately not repeated here.
 */
type NoticeWarning = Extract<
  ExecutionWarning,
  {
    code:
      | 'COOKIE_JAR_UNAVAILABLE'
      | 'TLS_MATERIAL_UNAVAILABLE'
      | 'HTTP2_DOWNGRADED'
      | 'CONTENT_TYPE_REPLACED'
      | 'ENV_WRITE_NOT_PERSISTED'
  }
>

const NOTICE_CODES: ReadonlySet<ExecutionWarning['code']> = new Set([
  'COOKIE_JAR_UNAVAILABLE',
  'TLS_MATERIAL_UNAVAILABLE',
  'HTTP2_DOWNGRADED',
  'CONTENT_TYPE_REPLACED',
  'ENV_WRITE_NOT_PERSISTED'
])

export function noticeWarningsOf(warnings: ExecutionWarning[] | undefined): NoticeWarning[] {
  return (warnings ?? []).filter((w): w is NoticeWarning => NOTICE_CODES.has(w.code))
}

interface ExecutionNoticesProps {
  warnings: ExecutionWarning[] | undefined
}

export function ExecutionNotices({ warnings }: ExecutionNoticesProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [dismissedFor, setDismissedFor] = useState<ExecutionWarning[] | undefined>(undefined)
  const notices = noticeWarningsOf(warnings)
  // Dismissal is per send: a new result (a new array) shows its notices again.
  if (notices.length === 0 || dismissedFor === warnings) return null

  const message = (w: NoticeWarning): string => {
    switch (w.code) {
      case 'COOKIE_JAR_UNAVAILABLE':
        return w.phase === 'read'
          ? t('response.notices.cookieJarRead', { reason: w.reason })
          : t('response.notices.cookieJarPersist', { reason: w.reason })
      case 'TLS_MATERIAL_UNAVAILABLE':
        return t('response.notices.tls', { reason: w.reason })
      case 'HTTP2_DOWNGRADED':
        return t('response.notices.http2Downgraded')
      case 'CONTENT_TYPE_REPLACED':
        return t('response.notices.contentTypeReplaced')
      case 'ENV_WRITE_NOT_PERSISTED':
        return w.reason === 'KEY_MISSING'
          ? t('response.notices.envWriteKeyMissing', { name: w.name })
          : t('response.notices.envWriteKeyMismatch', { name: w.name })
    }
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-border bg-warning/10 px-3 py-2 text-xs text-foreground"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-text" aria-hidden />
      <ul className="flex-1 space-y-0.5">
        {notices.map((w, i) => (
          <li key={`${w.code}-${i}`}>{message(w)}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setDismissedFor(warnings)}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label={t('response.notices.dismiss')}
        title={t('response.notices.dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
