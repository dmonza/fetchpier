import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { VariableHighlightInput } from '../ui/VariableHighlightInput'
import type { AuthConfig } from '../../../shared/types'

type AuthType = AuthConfig['type']
const AUTH_TYPES: AuthType[] = ['none', 'bearer', 'basic', 'api-key']

interface AuthEditorProps {
  auth: AuthConfig
  onChange: (auth: AuthConfig) => void
  /** If true, all controls are disabled */
  readOnly?: boolean
  /** Active environment variables — enables {{variable}} highlighting and autocomplete */
  variables?: Record<string, string | null>
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  readOnly = false,
  variables = {},
  secret = false
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  readOnly?: boolean
  variables?: Record<string, string | null>
  /** REQ-0089: mask the value (dots + brief last-char reveal); `{{var}}` stays visible. */
  secret?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <VariableHighlightInput
        type={type}
        secret={secret}
        value={value}
        onChange={(e) => !readOnly && onChange(e.target.value)}
        readOnly={readOnly}
        placeholder={placeholder}
        variables={variables}
        className={cn(
          'h-8 w-full rounded-md border border-border-default bg-background',
          'focus-within:ring-1 focus-within:ring-ring',
          readOnly && 'cursor-default opacity-75'
        )}
        inputClassName="px-3 text-sm focus:outline-none"
      />
    </div>
  )
}

export function AuthEditor({
  auth,
  onChange,
  readOnly = false,
  variables = {}
}: AuthEditorProps): React.JSX.Element {
  const { t } = useTranslation()

  const setType = (type: AuthType): void => {
    switch (type) {
      case 'none':
        onChange({ type: 'none' })
        break
      case 'bearer':
        onChange({ type: 'bearer', token: '' })
        break
      case 'basic':
        onChange({ type: 'basic', username: '', password: '' })
        break
      case 'api-key':
        onChange({ type: 'api-key', key: '', value: '', location: 'header' })
        break
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Auth type selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-muted-foreground">{t('request.auth.type')}</label>
        <div className="flex gap-3">
          {AUTH_TYPES.map((type) => (
            <label
              key={type}
              className={cn('flex items-center gap-1.5', !readOnly && 'cursor-pointer')}
            >
              <input
                type="radio"
                name="auth-type"
                value={type}
                checked={auth.type === type}
                onChange={() => !readOnly && setType(type)}
                disabled={readOnly}
                className="accent-primary"
              />
              <span
                className={cn(
                  'text-xs',
                  auth.type === type ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {t(`request.auth.types.${type}`)}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Dynamic fields */}
      {auth.type === 'none' && (
        <p className="text-xs text-muted-foreground">{t('request.auth.noAuth')}</p>
      )}

      {auth.type === 'bearer' && (
        <Field
          label={t('request.auth.token')}
          value={auth.token}
          onChange={(v) => onChange({ ...auth, token: v })}
          placeholder={t('request.auth.tokenPlaceholder')}
          readOnly={readOnly}
          variables={variables}
        />
      )}

      {auth.type === 'basic' && (
        <div className="flex flex-col gap-3">
          <Field
            label={t('request.auth.username')}
            value={auth.username}
            onChange={(v) => onChange({ ...auth, username: v })}
            readOnly={readOnly}
            variables={variables}
          />
          <Field
            label={t('request.auth.password')}
            value={auth.password}
            onChange={(v) => onChange({ ...auth, password: v })}
            secret
            readOnly={readOnly}
            variables={variables}
          />
        </div>
      )}

      {auth.type === 'api-key' && (
        <div className="flex flex-col gap-3">
          <Field
            label={t('request.auth.keyName')}
            value={auth.key}
            onChange={(v) => onChange({ ...auth, key: v })}
            placeholder="X-API-Key"
            readOnly={readOnly}
            variables={variables}
          />
          <Field
            label={t('request.auth.keyValue')}
            value={auth.value}
            onChange={(v) => onChange({ ...auth, value: v })}
            readOnly={readOnly}
            variables={variables}
          />
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">{t('request.auth.keyLocation')}</label>
            <div className="flex gap-3">
              {(['header', 'query'] as const).map((loc) => (
                <label
                  key={loc}
                  className={cn('flex items-center gap-1.5', !readOnly && 'cursor-pointer')}
                >
                  <input
                    type="radio"
                    name="api-key-location"
                    value={loc}
                    checked={auth.location === loc}
                    onChange={() => !readOnly && onChange({ ...auth, location: loc })}
                    disabled={readOnly}
                    className="accent-primary"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t(`request.auth.locations.${loc}`)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
