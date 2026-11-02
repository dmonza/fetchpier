import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { changeLanguage } from '../i18n'

const SUPPORTED_LANGUAGES = ['en', 'es'] as const

export function LanguageSelector(): React.JSX.Element {
  const { t, i18n } = useTranslation()

  return (
    <div className="relative flex items-center">
      <select
        value={i18n.language}
        onChange={(e) => changeLanguage(e.target.value)}
        className="h-7 appearance-none rounded-md border border-border-default bg-background pl-2 pr-6 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label={t('language.label')}
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang} value={lang}>
            {t(`language.${lang}`)}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" />
    </div>
  )
}
