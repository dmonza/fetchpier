import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { WindowControls } from '../layout/WindowControls'
import type { WindowPlatform } from '../../../shared/types'

/**
 * Titlebar for the Activity Panel popout window. The popout is frameless on
 * Windows/Linux (`frame: false`) and uses `titleBarStyle: 'hiddenInset'` on
 * macOS, so without this strip the window cannot be dragged/closed on Win/Linux
 * and the macOS traffic lights overlap the content.
 *
 * - macOS: a draggable strip with left padding so the native traffic lights are
 *   not covered; no custom buttons (the traffic lights provide them).
 * - Windows/Linux: a draggable strip with custom controls wired to the popout's
 *   OWN window via the sender-scoped `self*` IPC (see window-controls.ipc.ts),
 *   so they never affect the main window.
 */
export function PopoutTitleBar(): React.JSX.Element {
  const { t } = useTranslation()

  const [platform, setPlatform] = useState<WindowPlatform | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isFocused, setIsFocused] = useState(true)

  useEffect(() => {
    window.api.window.getPlatform().then(setPlatform).catch(console.error)
    window.api.window.selfIsMaximized().then(setIsMaximized).catch(console.error)
    const unsubMax = window.api.window.onMaximizedChanged(setIsMaximized)
    const unsubFocus = window.api.window.onFocusChanged(setIsFocused)
    return () => {
      unsubMax()
      unsubFocus()
    }
  }, [])

  const isMac = platform === 'darwin'
  const showCustomButtons = platform !== null && !isMac

  const handleDoubleClick = (): void => {
    if (!showCustomButtons) return
    window.api.window.selfMaximizeToggle().catch(console.error)
  }

  return (
    <div
      className={cn(
        'titlebar flex items-center bg-background border-b border-border select-none shrink-0',
        !isFocused && 'titlebar--unfocused'
      )}
      style={{ height: 'var(--titlebar-height)' }}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className={cn(
          'flex items-center gap-2 px-3 text-xs font-medium text-foreground',
          !isFocused && 'opacity-60',
          isMac && 'pl-20'
        )}
      >
        <span className="truncate max-w-[320px]">{t('activityPanel.popoutWindow.title')}</span>
      </div>

      <div className="flex-1" />

      {showCustomButtons && (
        <WindowControls
          onMinimize={() => window.api.window.selfMinimize().catch(console.error)}
          onMaximizeToggle={() => window.api.window.selfMaximizeToggle().catch(console.error)}
          onClose={() => window.api.window.selfClose().catch(console.error)}
          isMaximized={isMaximized}
          isFocused={isFocused}
        />
      )}
    </div>
  )
}
