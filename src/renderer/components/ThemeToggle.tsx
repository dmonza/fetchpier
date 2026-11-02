import { Sun, Moon, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { useThemeStore } from '../stores/theme'
import type { Theme } from '../../shared/types'

const CYCLE: Theme[] = ['light', 'dark', 'system']

const ICONS: Record<Theme, React.ReactNode> = {
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
  system: <Monitor className="h-4 w-4" />
}

export function ThemeToggle(): React.JSX.Element {
  const { t } = useTranslation()
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  const LABELS: Record<Theme, string> = {
    light: t('theme.switchToDark'),
    dark: t('theme.switchToSystem'),
    system: t('theme.switchToLight')
  }

  const handleClick = (): void => {
    const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length]
    setTheme(next)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      onClick={handleClick}
      aria-label={LABELS[theme]}
      title={LABELS[theme]}
    >
      {ICONS[theme]}
    </Button>
  )
}
