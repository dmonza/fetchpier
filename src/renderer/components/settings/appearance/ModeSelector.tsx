import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { Theme } from '../../../../shared/types'

const MODES: Theme[] = ['system', 'light', 'dark']

/** System / Light / Dark — applies at once, like the tab-bar button it stays in step with. */
export function ModeSelector({
  value,
  onChange
}: {
  value: Theme
  onChange: (next: Theme) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      role="radiogroup"
      aria-label={t('settings.appearance.mode.label')}
      className="inline-flex rounded-md border border-border-default bg-background p-0.5"
    >
      {MODES.map((mode) => {
        const checked = value === mode
        const label = t(`settings.appearance.mode.${mode}`)
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(mode)}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              checked
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
