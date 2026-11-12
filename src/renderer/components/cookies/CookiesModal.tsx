import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Cookie as CookieIcon,
  Plus,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  Search,
  X
} from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import { useCookieStore } from '../../stores/cookies'
import type { Cookie } from '../../../shared/types'
import { CookieForm } from './CookieForm'
import { cookieErrorText } from './cookie-error'

interface Props {
  /** Stable id of the environment that owns this cookie jar (used for IPC). */
  environmentId: string | null
  /** Display name of the environment (used in the modal title). */
  environmentName: string | null
  currentUrl?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function hostnameFromUrl(url: string): string {
  try {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
    return new URL(normalized).hostname
  } catch {
    return ''
  }
}

function domainMatchesHostname(cookieDomain: string, hostname: string): boolean {
  if (!hostname) return false
  const d = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain
  return hostname === d || hostname.endsWith(`.${d}`)
}

// The jar's rule: a Max-Age lifetime is measured from the last time the cookie
// was received (`updatedAt`), not from its first capture — a server that
// refreshes a sliding session restarts the countdown.
function isCookieExpired(cookie: Cookie, now = Date.now()): boolean {
  if (cookie.maxAge !== null) {
    const received = Date.parse(cookie.updatedAt)
    if (!Number.isFinite(received)) return false
    return received + cookie.maxAge * 1000 <= now
  }
  if (cookie.expires) {
    const expiry = Date.parse(cookie.expires)
    if (!Number.isFinite(expiry)) return false
    return expiry <= now
  }
  return false
}

function formatExpires(cookie: Cookie, t: ReturnType<typeof useTranslation>['t']): string {
  if (isCookieExpired(cookie)) return t('cookies.expired')
  if (!cookie.expires && cookie.maxAge === null) return t('cookies.session')
  if (cookie.maxAge !== null) {
    const end = Date.parse(cookie.updatedAt) + cookie.maxAge * 1000
    const seconds = Math.max(0, Math.round((end - Date.now()) / 1000))
    return t('cookies.inSeconds', { count: seconds })
  }
  if (cookie.expires) {
    const seconds = Math.max(0, Math.round((Date.parse(cookie.expires) - Date.now()) / 1000))
    return t('cookies.inSeconds', { count: seconds })
  }
  return ''
}

export function CookiesModal({
  environmentId,
  environmentName,
  currentUrl,
  open,
  onOpenChange
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const cookies = useCookieStore((s) => s.cookies)
  const loadForEnvironment = useCookieStore((s) => s.loadForEnvironment)
  const clearAll = useCookieStore((s) => s.clearAll)
  const remove = useCookieStore((s) => s.remove)
  const loadError = useCookieStore((s) => s.loadError)

  // A delete or "Clear all" the jar refused (e.g. an unreadable jar file).
  const [actionError, setActionError] = useState<string | null>(null)
  const failAction = (err: unknown): void => {
    console.error(err)
    setActionError(cookieErrorText(err, t))
  }
  const panelError = actionError ?? (loadError !== null ? cookieErrorText(loadError, t) : null)

  const [editing, setEditing] = useState<Cookie | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  // Tracks domains the user has manually flipped from the URL-driven default.
  const [userToggled, setUserToggled] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (open && environmentId) loadForEnvironment(environmentId)
  }, [open, environmentId, loadForEnvironment])

  const groups = useMemo(() => {
    const byDomain = new Map<string, Cookie[]>()
    for (const c of cookies) {
      const list = byDomain.get(c.domain) ?? []
      list.push(c)
      byDomain.set(c.domain, list)
    }
    return [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [cookies])

  const currentHostname = useMemo(() => hostnameFromUrl(currentUrl ?? ''), [currentUrl])
  const defaultCollapsed = useCallback(
    (domain: string): boolean => !domainMatchesHostname(domain, currentHostname),
    [currentHostname]
  )

  const filteredGroups = useMemo(() => {
    if (!query.trim()) return groups
    const q = query.toLowerCase()
    return groups
      .map(([domain, list]) => {
        // Domain name matches → show all cookies in that domain
        if (domain.toLowerCase().includes(q)) return [domain, list] as [string, Cookie[]]
        // Otherwise filter cookies by name or value
        const matched = list.filter(
          (c) => c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)
        )
        if (matched.length === 0) return null
        return [domain, matched] as [string, Cookie[]]
      })
      .filter((g): g is [string, Cookie[]] => g !== null)
  }, [groups, query])

  const toggleDomain = (domain: string): void => {
    setUserToggled((prev) => {
      const next = new Set(prev)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  // When searching, domains with results are always expanded.
  // Otherwise: collapsed = default XOR user-toggled.
  const isDomainCollapsed = (domain: string): boolean => {
    if (query.trim()) return false
    return defaultCollapsed(domain) !== userToggled.has(domain)
  }

  const totalVisible = filteredGroups.reduce((sum, [, list]) => sum + list.length, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-3xl flex-col gap-0 p-0" style={{ height: '80vh' }}>
        {/* Header */}
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <CookieIcon className="h-4 w-4" />
            {t('cookies.title', { env: environmentName ?? '' })}
          </DialogTitle>
        </DialogHeader>

        {/* Toolbar: search + count + new */}
        <div className="shrink-0 border-b border-border px-4 py-2 flex flex-col gap-2">
          {/* Search */}
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('cookies.search')}
              className="h-8 w-full rounded-md border border-border-default bg-background pl-8 pr-8 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {/* Count + new button */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t('cookies.count', { count: query.trim() ? totalVisible : cookies.length })}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(null)
                setShowForm(true)
              }}
            >
              <Plus className="h-3.5 w-3.5" /> {t('cookies.new')}
            </Button>
          </div>
        </div>

        {panelError && (
          <div
            role="alert"
            className="shrink-0 border-b border-border px-4 py-2 text-xs text-danger-text"
          >
            {panelError}
          </div>
        )}

        {/* Results — scrollable */}
        <div className="flex-1 overflow-auto">
          <div className="rounded border-border">
            {filteredGroups.length === 0 && !query.trim() && (
              <div className="p-6 text-center text-xs text-muted-foreground">
                {t('cookies.empty')}
              </div>
            )}
            {filteredGroups.length === 0 && query.trim() && (
              <div className="p-6 text-center text-xs text-muted-foreground">
                {t('cookies.noResults', { query })}
              </div>
            )}
            {filteredGroups.map(([domain, list]) => {
              const collapsed = isDomainCollapsed(domain)
              return (
                <div key={domain} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => toggleDomain(domain)}
                    className="flex w-full items-center justify-between bg-surface-2 px-3 py-1.5 text-xs font-semibold hover:bg-accent transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      {collapsed ? (
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      )}
                      {domain}
                    </span>
                    <Badge variant="muted">{list.length}</Badge>
                  </button>
                  {!collapsed && (
                    <table className="w-full table-fixed text-xs">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="w-32 px-2 py-1 text-left">{t('cookies.name')}</th>
                          <th className="px-2 py-1 text-left">{t('cookies.value')}</th>
                          <th className="w-20 px-2 py-1 text-left">{t('cookies.path')}</th>
                          <th className="w-32 px-2 py-1 text-left">{t('cookies.expires')}</th>
                          <th className="w-20 px-2 py-1 text-left">{t('cookies.source')}</th>
                          <th className="w-16 px-2 py-1"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((c) => {
                          const expired = isCookieExpired(c)
                          return (
                            <tr
                              key={c.id}
                              className={cn('border-t border-border/50', expired && 'opacity-60')}
                            >
                              <td className="truncate px-2 py-1 font-mono" title={c.name}>
                                {c.name}
                              </td>
                              <td className="truncate px-2 py-1 font-mono" title={c.value}>
                                {c.value}
                              </td>
                              <td className="truncate px-2 py-1 font-mono" title={c.path}>
                                {c.path}
                              </td>
                              <td className="truncate px-2 py-1">{formatExpires(c, t)}</td>
                              <td className="px-2 py-1">
                                <Badge variant={c.source === 'manual' ? 'outline' : 'muted'}>
                                  {c.source}
                                </Badge>
                              </td>
                              <td className="px-2 py-1 text-right">
                                <button
                                  className="mr-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                  onClick={() => {
                                    setEditing(c)
                                    setShowForm(true)
                                  }}
                                  title={t('cookies.edit')}
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                                <button
                                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-danger-text"
                                  onClick={() => {
                                    if (confirm(t('cookies.confirmDelete', { name: c.name }))) {
                                      setActionError(null)
                                      remove(c.id).catch(failAction)
                                    }
                                  }}
                                  title={t('cookies.delete')}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="shrink-0 border-t border-border px-4 py-2">
          {/* Also offered over an unreadable jar: it is the way to start over. */}
          {(cookies.length > 0 || loadError !== null) && !confirmClearAll && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmClearAll(true)}
              className="mr-auto text-danger-text"
            >
              {t('cookies.clearAll')}
            </Button>
          )}
          {confirmClearAll && (
            <div className="mr-auto flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t('cookies.confirmClearAll')}</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setActionError(null)
                  clearAll().catch(failAction)
                  setConfirmClearAll(false)
                }}
              >
                {t('cookies.clearAll')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmClearAll(false)}>
                {t('cookies.cancel')}
              </Button>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('cookies.close')}
          </Button>
        </DialogFooter>

        {showForm && environmentId && (
          <CookieForm
            cookie={editing}
            environmentId={environmentId}
            onClose={() => {
              setShowForm(false)
              setEditing(null)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
