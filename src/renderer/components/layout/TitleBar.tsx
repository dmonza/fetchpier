import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { basenameOfPath } from '../../lib/path'
import { useWorkspaceStore } from '../../stores/workspace'
import { AboutTrigger } from './AboutPanel'
import { WindowControls } from './WindowControls'
import type { WindowPlatform } from '../../../shared/types'

export function TitleBar(): React.JSX.Element {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const [platform, setPlatform] = useState<WindowPlatform | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isFocused, setIsFocused] = useState(true)

  useEffect(() => {
    window.api.window.getPlatform().then(setPlatform).catch(console.error)
    window.api.window.isMaximized().then(setIsMaximized).catch(console.error)
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
    window.api.window.maximizeToggle().catch(console.error)
  }

  const workspaceName = workspacePath ? basenameOfPath(workspacePath) : null
  const appName = t('about.appName')
  const titleText = workspaceName ? `${appName} — ${workspaceName}` : appName

  return (
    <div
      className={cn(
        'titlebar flex items-center bg-background border-b border-border select-none shrink-0',
        !isFocused && 'titlebar--unfocused'
      )}
      style={{ height: 'var(--titlebar-height)' }}
      onDoubleClick={handleDoubleClick}
    >
      {/* Left zone */}
      <div
        className={cn(
          'flex items-center gap-2 px-3 text-xs font-medium text-foreground',
          !isFocused && 'opacity-60',
          isMac && 'pl-20'
        )}
      >
        {!isMac && <span className="h-2 w-2 rounded-sm bg-primary" aria-hidden="true" />}
        <span className="truncate max-w-[320px]">{titleText}</span>
      </div>

      {/* Center zone — reserved for future controls */}
      <div className="flex-1" />

      {/* Right zone */}
      <div className={cn('flex h-full items-stretch', !isFocused && 'opacity-60')}>
        <AboutTrigger />
      </div>

      {showCustomButtons && (
        <WindowControls
          onMinimize={() => window.api.window.minimize().catch(console.error)}
          onMaximizeToggle={() => window.api.window.maximizeToggle().catch(console.error)}
          onClose={() => window.api.window.close().catch(console.error)}
          isMaximized={isMaximized}
          isFocused={isFocused}
        />
      )}
    </div>
  )
}
