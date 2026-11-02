import { Minus, Square, Copy, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

interface WindowControlsProps {
  onMinimize: () => void
  onMaximizeToggle: () => void
  onClose: () => void
  isMaximized: boolean
  isFocused: boolean
}

/**
 * The minimize / maximize-restore / close button group for a custom titlebar on
 * Windows and Linux (frameless windows). Shared by the main window's
 * `TitleBar` and the Activity Panel popout's `PopoutTitleBar`; the handlers are
 * injected so each can target its own window. On macOS the native traffic
 * lights are used instead, so callers do not render this component there.
 *
 * Wrapped in `.titlebar-interactive` so the buttons opt out of the surrounding
 * `-webkit-app-region: drag` titlebar.
 */
export function WindowControls({
  onMinimize,
  onMaximizeToggle,
  onClose,
  isMaximized,
  isFocused
}: WindowControlsProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="titlebar-interactive flex h-full items-stretch">
      <button
        type="button"
        aria-label={t('titlebar.minimize')}
        title={t('titlebar.minimize')}
        onClick={onMinimize}
        className={cn(
          'flex h-full w-12 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
          !isFocused && 'opacity-60'
        )}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? t('titlebar.restore') : t('titlebar.maximize')}
        title={isMaximized ? t('titlebar.restore') : t('titlebar.maximize')}
        onClick={onMaximizeToggle}
        className={cn(
          'flex h-full w-12 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
          !isFocused && 'opacity-60'
        )}
      >
        {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        aria-label={t('titlebar.close')}
        title={t('titlebar.close')}
        onClick={onClose}
        className={cn(
          'flex h-full w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white',
          !isFocused && 'opacity-60'
        )}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
