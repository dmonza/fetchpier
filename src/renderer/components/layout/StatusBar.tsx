import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Command, History } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useThemeStore } from '../../stores/theme'
import { useWorkspaceStore } from '../../stores/workspace'
import { useDisplayStore } from '../../stores/display'
import { useActivityPanelStore } from '../../stores/activityPanel'
import { OPEN_COMMAND_PALETTE_EVENT } from '../../lib/events'
import type { WindowPlatform } from '../../../shared/types'

export function StatusBar(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const theme = useThemeStore((s) => s.theme)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const zoomFactor = useDisplayStore((s) => s.zoomFactor)
  const resetZoom = useDisplayStore((s) => s.resetZoom)
  const activityPanelOpen = useActivityPanelStore((s) => s.isOpen)
  const activityPanelDetached = useActivityPanelStore((s) => s.isDetached)
  const toggleActivityPanel = useActivityPanelStore((s) => s.toggle)

  const [platform, setPlatform] = useState<WindowPlatform | null>(null)

  useEffect(() => {
    window.api.window.getPlatform().then(setPlatform).catch(console.error)
  }, [])

  const isMac = platform === 'darwin'
  const shortcutLabel = isMac ? '⌘P' : 'Ctrl+P'
  const activityShortcutLabel = isMac ? '⌘J' : 'Ctrl+J'

  const themeLabel = t(`statusBar.theme.${theme}`)
  const langLabel = t(`language.${i18n.language}`)
  const workspaceLabel = workspacePath ?? t('statusBar.noWorkspace')

  const zoomPercent = Math.round(zoomFactor * 100)
  const isZoomed = zoomPercent !== 100

  const openPalette = (): void => {
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))
  }

  const isActivityPanelActive = activityPanelOpen || activityPanelDetached

  return (
    <div className="flex h-6 items-center gap-4 border-t border-border bg-muted px-3 text-xs text-muted-foreground select-none shrink-0">
      <span className="truncate max-w-sm" title={workspacePath ?? undefined}>
        {workspaceLabel}
      </span>
      <button
        type="button"
        onClick={toggleActivityPanel}
        title={t('activityPanel.toggle.tooltip', { shortcut: activityShortcutLabel })}
        aria-label={t('activityPanel.toggle.ariaLabel')}
        aria-pressed={isActivityPanelActive}
        className={cn(
          'flex items-center gap-1 rounded px-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          isActivityPanelActive
            ? 'bg-primary/15 text-primary hover:text-primary'
            : 'hover:text-foreground'
        )}
      >
        <History className="h-3 w-3" />
        <span>{t('history.title')}</span>
      </button>
      <span className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={openPalette}
          title={t('statusBar.commandPalette.tooltip', { shortcut: shortcutLabel })}
          className="flex items-center gap-1 rounded px-1 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Command className="h-3 w-3" />
          <span className="font-mono">{shortcutLabel}</span>
        </button>
        <span>{langLabel}</span>
        <span>{themeLabel}</span>
        <button
          onClick={isZoomed ? resetZoom : undefined}
          title={isZoomed ? t('statusBar.zoom.resetTooltip') : t('statusBar.zoom.tooltip')}
          className={
            isZoomed
              ? 'cursor-pointer text-primary hover:text-foreground transition-colors'
              : 'cursor-default'
          }
        >
          {t('statusBar.zoom.label', { percent: zoomPercent })}
        </button>
      </span>
    </div>
  )
}
