import { useTranslation } from 'react-i18next'
import { FilePlus2 } from 'lucide-react'
import { Button } from '../ui/button'
import { useRequestStore } from '../../stores/request'

/**
 * Shown in the editor area when no tab is open (REQ-0084). Minimal by design:
 * a single "New request" action and its shortcut hint. The sidebar stays fully
 * functional alongside it.
 */
export function EmptyState(): React.JSX.Element {
  const { t } = useTranslation()
  const openTab = useRequestStore((s) => s.openTab)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const shortcut = isMac ? '⌘ N' : 'Ctrl N'

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
        <FilePlus2 className="h-7 w-7" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-foreground">{t('emptyState.title')}</h2>
        <p className="max-w-xs text-xs text-muted-foreground">{t('emptyState.description')}</p>
      </div>
      <Button onClick={() => openTab()} size="sm">
        {t('emptyState.newRequest')}
      </Button>
      <p className="text-xs text-muted-foreground">
        {t('emptyState.shortcutHint')}{' '}
        <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
          {shortcut}
        </kbd>
      </p>
    </div>
  )
}
