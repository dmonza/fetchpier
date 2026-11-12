import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import type { ClientCertPreview } from '../../../shared/types'
import { useEnvironmentStore } from '../../stores/environment'

interface Props {
  /**
   * The request URL as the editor holds it (`{{variables}}` unresolved). Main
   * resolves it against the active environment, as the send does. May be empty.
   */
  url: string
}

const DEBOUNCE_MS = 200

/**
 * Read-only line shown in the per-request Settings tab indicating which
 * client certificate (if any) will be presented for the current URL.
 * Re-queries the main process on URL changes (debounced) and on the
 * `certificates:changed` broadcast.
 */
export function ClientCertificatePreview({ url }: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<ClientCertPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refresh = useRef<() => void>(() => {})
  // The URL resolves against the active environment: switching it or editing
  // its variables can change the answer.
  const activeEnvironmentId = useEnvironmentStore((s) => s.activeEnvironmentId)
  const activeVariables = useEnvironmentStore(
    (s) => s.environments.find((e) => e.id === s.activeEnvironmentId)?.variables
  )

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    refresh.current = async (): Promise<void> => {
      if (!url.trim()) {
        setPreview({ selected: null, scope: null })
        return
      }
      setLoading(true)
      try {
        const next = await window.api.certificates.previewForRequest({ url })
        setPreview(next)
      } catch (err) {
        console.error('[ClientCertificatePreview] preview failed:', err)
      } finally {
        setLoading(false)
      }
    }
    timer.current = setTimeout(() => {
      refresh.current()
    }, DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [url, activeEnvironmentId, activeVariables])

  useEffect(() => {
    const unsubscribe = window.api.certificates.onChanged(() => {
      refresh.current()
    })
    return () => unsubscribe()
  }, [])

  if (!preview && !loading) return null

  const selected = preview?.selected
  const scope = preview?.scope
  const fileName = selected
    ? selected.type === 'pfx'
      ? selected.pfxFile
      : selected.certFile
    : null

  return (
    <div className="flex items-center gap-2 border-b border-border py-2 text-xs">
      <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-medium text-foreground">{t('certificates.preview.label')}:</span>
      {selected ? (
        <span className="text-muted-foreground">
          <span className="font-mono text-foreground">{fileName ?? selected.host}</span>
          {' · '}
          <span>
            {scope === 'workspace'
              ? t('certificates.preview.scopeWorkspace')
              : t('certificates.preview.scopeApp')}
          </span>
        </span>
      ) : preview?.undetermined ? (
        <span className="text-muted-foreground">{t('certificates.preview.undetermined')}</span>
      ) : (
        <span className="text-muted-foreground">{t('certificates.preview.none')}</span>
      )}
    </div>
  )
}
