import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { useCookieStore } from '../../stores/cookies'
import type { Cookie, CookieSameSite } from '../../../shared/types'

interface Props {
  cookie: Cookie | null
  /** Currently unused — the store holds the active env. Kept for call-site clarity. */
  environmentId: string
  onClose: () => void
}

// Cookie names must be RFC 6265 tokens — control chars (U+0000–U+001F) are invalid by spec.
// eslint-disable-next-line no-control-regex
const INVALID_NAME = /[=;\s\u0000-\u001f]/

/**
 * A stored UTC instant as the `YYYY-MM-DDTHH:mm` local wall-clock value a
 * `datetime-local` input shows. Empty for no (or an unparseable) expiry.
 */
function toLocalInputValue(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const offsetMs = new Date(ms).getTimezoneOffset() * 60_000
  return new Date(ms - offsetMs).toISOString().slice(0, 16)
}

export function CookieForm({ cookie, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const create = useCookieStore((s) => s.create)
  const update = useCookieStore((s) => s.update)

  const [name, setName] = useState(cookie?.name ?? '')
  const [value, setValue] = useState(cookie?.value ?? '')
  const [domain, setDomain] = useState(cookie?.domain ?? '')
  const [path, setPath] = useState(cookie?.path ?? '/')
  // The stored UTC instant (ISO). The input shows it in local time and an edit
  // converts back, so an untouched expiry is saved exactly as it was.
  const [expires, setExpires] = useState(cookie?.expires ?? '')
  const [maxAge, setMaxAge] = useState<string>(
    cookie?.maxAge !== null && cookie?.maxAge !== undefined ? String(cookie.maxAge) : ''
  )
  const [secure, setSecure] = useState(cookie?.secure ?? false)
  // REQ-0115: `HttpOnly` and the cross-site attribute are not editable here —
  // neither governs anything in an API client (see the form's footnote), so a
  // control for them would be a knob that does nothing.
  //
  // They are still carried through untouched. Dropping them to a default would
  // mean that editing a captured cookie's path silently erased attributes the
  // server had set, which is the kind of quiet damage this whole change exists
  // to remove. Add the controls back the day something reads them.
  const httpOnly = cookie?.httpOnly ?? false
  const sameSite: CookieSameSite | null = cookie?.sameSite ?? null
  // REQ-0115: an authored cookie must say whether it is bound to the exact host or
  // also covers subdomains — it is not inferable, and the previous behavior
  // (always covering subdomains) leaked credentials downward. Defaults to the
  // exact host, which is the restrictive reading.
  const [includeSubdomains, setIncludeSubdomains] = useState(
    cookie ? cookie.hostOnly === false : false
  )
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      setError(t('cookies.errors.nameRequired'))
      return
    }
    if (INVALID_NAME.test(name)) {
      setError(t('cookies.errors.nameInvalid'))
      return
    }
    if (!domain.trim()) {
      setError(t('cookies.errors.domainRequired'))
      return
    }

    // A leading dot is the specification's own spelling for "and its subdomains".
    // The engine normalizes it away and carries the meaning in the flag; mirroring
    // that here keeps the control and the typed value from disagreeing on screen.
    const typedDomain = domain.trim().toLowerCase()
    const payload = {
      name,
      value,
      domain: typedDomain.startsWith('.') ? typedDomain.slice(1) : typedDomain,
      path: path.trim() || '/',
      expires: expires ? new Date(expires).toISOString() : null,
      maxAge: maxAge ? Number(maxAge) : null,
      secure,
      httpOnly,
      sameSite,
      hostOnly: typedDomain.startsWith('.') ? false : !includeSubdomains
    }

    try {
      if (cookie) {
        await update(cookie.id, payload)
      } else {
        await create(payload)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {cookie ? t('cookies.form.editTitle') : t('cookies.form.newTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Field label={t('cookies.name')} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label={t('cookies.value')} required>
            <Input value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label={t('cookies.domain')} required>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} />
          </Field>
          <div className="flex items-center justify-between">
            <span className="text-xs">{t('cookies.includeSubdomains')}</span>
            <Switch checked={includeSubdomains} onCheckedChange={setIncludeSubdomains} />
          </div>
          <Field label={t('cookies.path')}>
            <Input value={path} onChange={(e) => setPath(e.target.value)} />
          </Field>
          <Field label={t('cookies.expiresDate')}>
            <Input
              type="datetime-local"
              value={expires ? toLocalInputValue(expires) : ''}
              onChange={(e) => {
                // The input's value is local wall-clock time; `new Date` reads it as such.
                const local = e.target.value
                const ms = local ? Date.parse(local) : NaN
                setExpires(Number.isFinite(ms) ? new Date(ms).toISOString() : '')
              }}
            />
          </Field>
          <Field label={t('cookies.maxAge')}>
            <Input
              type="number"
              min={0}
              value={maxAge}
              onChange={(e) => setMaxAge(e.target.value)}
            />
          </Field>
          <div className="flex items-center justify-between">
            <span className="text-xs">{t('cookies.secure')}</span>
            <Switch checked={secure} onCheckedChange={setSecure} />
          </div>
          {error && <div className="text-xs text-danger-text">{error}</div>}
          <p className="border-t border-border pt-2 text-xs text-muted-foreground">
            {t('cookies.form.inertAttributes')}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cookies.cancel')}
          </Button>
          <Button size="sm" onClick={() => submit().catch(console.error)}>
            {t('cookies.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  required,
  children
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        {required && <span className="text-danger-text"> *</span>}
      </span>
      {children}
    </label>
  )
}
