import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, FolderOpen, Pencil, AlertTriangle } from 'lucide-react'
import { useCertificateStore } from '../../stores/certificates'
import { certificateErrorText } from './certificate-error'
import { useEnvironmentStore } from '../../stores/environment'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { VariableHighlightInput } from '../ui/VariableHighlightInput'
import { isCompleteVariableReference } from '../../lib/variables-editing'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import type {
  CACertEntry,
  ClientCertEntry,
  TlsScope,
  TlsScopeSettings
} from '../../../shared/types'

/** Stable empty map so the env-store selector never returns a fresh object. */
const EMPTY_VARIABLES: Record<string, string | null> = {}

/** Value carries a `{{...}}` reference anywhere (used to reject app-global passphrases). */
function containsVariableReference(value: string): boolean {
  return /\{\{[^{}]+\}\}/.test(value)
}

/**
 * The port field: empty is any port, otherwise decimal digits naming 1–65535
 * (the store's rule). `undefined` marks an invalid entry.
 */
function parsePortField(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const port = Number(trimmed)
  return port >= 1 && port <= 65535 ? port : undefined
}

/**
 * REQ-0089: passphrase field. Both scopes mask the value with the shared
 * secret-masking input (dots + brief last-char reveal). Workspace scope is
 * variable-capable: a `{{variable}}` reference stays visible and offers the
 * `{{`-suggestion of the active environment's names. App-global is literal-only
 * (no `variables`), so everything is masked.
 */
function PassphraseInput({
  scope,
  value,
  onChange,
  variables
}: {
  scope: TlsScope
  value: string
  onChange: (value: string) => void
  variables: Record<string, string | null>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <VariableHighlightInput
      secret
      value={value}
      onChange={(e) => onChange(e.target.value)}
      variables={scope === 'workspace' ? variables : undefined}
      placeholder={
        scope === 'workspace'
          ? t('certificates.form.client.passphrasePlaceholder')
          : t('certificates.form.client.passphrasePlaceholderLiteral')
      }
      className="h-8 w-full rounded-md border border-input bg-background shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
      inputClassName="px-2 py-1 text-xs placeholder:text-muted-foreground"
    />
  )
}

/** A workspace-scope certificate whose passphrase is a non-empty clear-text literal. */
function isLiteralPassphrase(entry: ClientCertEntry): boolean {
  const p = entry.passphrase
  return typeof p === 'string' && p.trim().length > 0 && !isCompleteVariableReference(p)
}

/** Active environment's unified variable map (for workspace-scope passphrase editing). */
function useActiveEnvironmentVariables(): Record<string, string | null> {
  return useEnvironmentStore((s) => {
    if (!s.activeEnvironmentId) return EMPTY_VARIABLES
    return s.environments.find((e) => e.id === s.activeEnvironmentId)?.variables ?? EMPTY_VARIABLES
  })
}

interface Props {
  /** Which scope this panel manages. App-global lives in global Settings; workspace lives in the workspace dialog. */
  scope: TlsScope
}

/**
 * Manages CA + client certificates for a single scope. The host (global
 * Settings or Workspace Settings dialog) picks the scope and embeds the panel.
 */
export function CertificatesPanel({ scope }: Props): React.JSX.Element {
  const app = useCertificateStore((s) => s.app)
  const workspace = useCertificateStore((s) => s.workspace)
  const reloadScope = useCertificateStore((s) => s.reloadScope)

  useEffect(() => {
    void reloadScope(scope)
  }, [scope, reloadScope])

  const scopeSettings = scope === 'workspace' ? workspace : app

  // Self-contained Tooltip provider: the workspace Certificates tab is not under
  // the dialog's provider, and the per-row clear-text warning needs one.
  return (
    <TooltipProvider>
      <div className="px-4 py-4 space-y-4">
        <CASection scope={scope} settings={scopeSettings} />
        <ClientSection scope={scope} settings={scopeSettings} />
      </div>
    </TooltipProvider>
  )
}

// ── CA section ─────────────────────────────────────────────────────────────

function CASection({
  scope,
  settings
}: {
  scope: TlsScope
  settings: TlsScopeSettings
}): React.JSX.Element {
  const { t } = useTranslation()
  const [addOpen, setAddOpen] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const remove = useCertificateStore((s) => s.remove)

  async function handleRemove(entry: CACertEntry): Promise<void> {
    const label = entry.label ?? entry.file
    if (!window.confirm(t('certificates.remove.ca', { name: label }))) return
    setRowError(null)
    try {
      await remove({ scope, id: entry.id, kind: 'ca' })
    } catch (err) {
      setRowError(certificateErrorText(err, 'remove', t))
    }
  }

  return (
    <section>
      <SectionHeader
        title={t('certificates.sections.ca')}
        intro={t('certificates.intro.ca')}
        action={
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 h-3 w-3" />
            {t('certificates.actions.addCA')}
          </Button>
        }
      />

      {settings.caCertificates.length === 0 ? (
        <EmptyRow>{t('certificates.empty.ca')}</EmptyRow>
      ) : (
        <TableShell
          headers={[
            t('certificates.table.label'),
            t('certificates.table.file'),
            t('certificates.table.actions')
          ]}
        >
          {settings.caCertificates.map((entry) => (
            <tr key={entry.id} className="border-t border-border-default">
              <td className="px-3 py-2 text-xs text-foreground">
                {entry.label || (
                  <span className="text-muted-foreground italic">
                    {t('certificates.table.unnamed')}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{entry.file}</td>
              <td className="px-3 py-2 text-xs">
                <button
                  type="button"
                  onClick={() => handleRemove(entry)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('certificates.actions.remove')}
                </button>
              </td>
            </tr>
          ))}
        </TableShell>
      )}
      <RowError message={rowError} />

      {addOpen && <AddCAForm scope={scope} onClose={() => setAddOpen(false)} />}
    </section>
  )
}

// ── Client section ─────────────────────────────────────────────────────────

function ClientSection({
  scope,
  settings
}: {
  scope: TlsScope
  settings: TlsScopeSettings
}): React.JSX.Element {
  const { t } = useTranslation()
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<ClientCertEntry | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const updateClient = useCertificateStore((s) => s.updateClient)
  const remove = useCertificateStore((s) => s.remove)

  async function handleRemove(entry: ClientCertEntry): Promise<void> {
    if (!window.confirm(t('certificates.remove.client', { name: entry.host }))) return
    setRowError(null)
    try {
      await remove({ scope, id: entry.id, kind: 'client' })
    } catch (err) {
      setRowError(certificateErrorText(err, 'remove', t))
    }
  }

  async function handleToggleDisabled(entry: ClientCertEntry, enabled: boolean): Promise<void> {
    setRowError(null)
    try {
      await updateClient({ scope, id: entry.id, patch: { disabled: !enabled } })
    } catch (err) {
      setRowError(certificateErrorText(err, 'toggle', t))
    }
  }

  return (
    <section className="pt-2">
      <SectionHeader
        title={t('certificates.sections.client')}
        intro={t('certificates.intro.client')}
        action={
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 h-3 w-3" />
            {t('certificates.actions.addClient')}
          </Button>
        }
      />

      {settings.clientCertificates.length === 0 ? (
        <EmptyRow>{t('certificates.empty.client')}</EmptyRow>
      ) : (
        <TableShell
          headers={[
            t('certificates.table.host'),
            t('certificates.table.port'),
            t('certificates.table.type'),
            t('certificates.table.enabled'),
            t('certificates.table.actions')
          ]}
        >
          {settings.clientCertificates.map((entry) => (
            <tr key={entry.id} className="border-t border-border-default">
              <td className="px-3 py-2 text-xs font-mono text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  {entry.host}
                  {scope === 'workspace' && isLiteralPassphrase(entry) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={0}
                          className="inline-flex cursor-help"
                          aria-label={t('certificates.table.literalPassphraseWarning')}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning-text" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        {t('certificates.table.literalPassphraseWarning')}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </span>
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {entry.port ?? t('certificates.table.anyPort')}
              </td>
              <td className="px-3 py-2 text-xs uppercase text-muted-foreground">{entry.type}</td>
              <td className="px-3 py-2">
                <Switch
                  checked={!entry.disabled}
                  onCheckedChange={(checked) => handleToggleDisabled(entry, checked)}
                />
              </td>
              <td className="px-3 py-2 text-xs">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing(entry)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-foreground hover:bg-muted"
                  >
                    <Pencil className="h-3 w-3" />
                    {t('certificates.actions.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(entry)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('certificates.actions.remove')}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </TableShell>
      )}
      <RowError message={rowError} />

      {addOpen && <AddClientForm scope={scope} onClose={() => setAddOpen(false)} />}
      {editing && <EditClientForm scope={scope} entry={editing} onClose={() => setEditing(null)} />}
    </section>
  )
}

// ── Add CA dialog ──────────────────────────────────────────────────────────

function AddCAForm({
  scope,
  onClose
}: {
  scope: TlsScope
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const addCA = useCertificateStore((s) => s.addCA)
  const [sourcePath, setSourcePath] = useState<string>('')
  const [label, setLabel] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePick(): Promise<void> {
    const path = await window.api.certificates.pickSourceFile({ kind: 'ca' })
    if (path) setSourcePath(path)
  }

  async function handleSubmit(): Promise<void> {
    if (!sourcePath) {
      setError(t('certificates.errors.fileRequired'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await addCA({ scope, sourcePath, label: label.trim() || undefined })
      onClose()
    } catch (err) {
      setError(certificateErrorText(err, 'import', t))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('certificates.form.ca.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <FilePickerRow
            label={t('certificates.form.ca.file')}
            placeholder={t('certificates.form.ca.filePlaceholder')}
            value={sourcePath}
            onPick={handlePick}
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('certificates.form.ca.label')}
            </label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('certificates.form.ca.labelPlaceholder')}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('certificates.actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !sourcePath}>
            {t('certificates.actions.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Add client cert dialog ─────────────────────────────────────────────────

function AddClientForm({
  scope,
  onClose
}: {
  scope: TlsScope
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const addClient = useCertificateStore((s) => s.addClient)
  const variables = useActiveEnvironmentVariables()
  const [type, setType] = useState<'pem' | 'pfx'>('pem')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [certPath, setCertPath] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [pfxPath, setPfxPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const showPassphraseWarning = useMemo(
    () =>
      scope === 'workspace' &&
      passphrase.trim().length > 0 &&
      !isCompleteVariableReference(passphrase),
    [scope, passphrase]
  )

  async function pick(
    kind: 'pemCert' | 'pemKey' | 'pfx',
    setter: (p: string) => void
  ): Promise<void> {
    const path = await window.api.certificates.pickSourceFile({ kind })
    if (path) setter(path)
  }

  async function handleSubmit(): Promise<void> {
    setError(null)
    if (!host.trim()) {
      setError(t('certificates.errors.hostRequired'))
      return
    }
    if (scope === 'app' && containsVariableReference(passphrase)) {
      setError(t('certificates.errors.passphraseVariableNotAllowed'))
      return
    }
    if (type === 'pem' && (!certPath || !keyPath)) {
      setError(t('certificates.errors.fileRequired'))
      return
    }
    if (type === 'pfx' && !pfxPath) {
      setError(t('certificates.errors.fileRequired'))
      return
    }
    const parsedPort = parsePortField(port)
    if (parsedPort === undefined) {
      setError(t('certificates.errors.invalidPort'))
      return
    }
    setSubmitting(true)
    try {
      await addClient({
        scope,
        host: host.trim(),
        port: parsedPort,
        type,
        sourcePaths: type === 'pem' ? { certPath, keyPath } : { pfxPath },
        passphrase: passphrase.trim() ? passphrase : null
      })
      onClose()
    } catch (err) {
      setError(certificateErrorText(err, 'import', t))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('certificates.form.client.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('certificates.form.client.type')}
            </label>
            <Select value={type} onValueChange={(v) => setType(v as 'pem' | 'pfx')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pem">{t('certificates.form.client.typePem')}</SelectItem>
                <SelectItem value="pfx">{t('certificates.form.client.typePfx')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('certificates.form.client.host')}
              </label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={t('certificates.form.client.hostPlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('certificates.form.client.port')}
              </label>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={t('certificates.form.client.portPlaceholder')}
                className="w-24"
              />
            </div>
          </div>

          {type === 'pem' ? (
            <>
              <FilePickerRow
                label={t('certificates.form.client.certFile')}
                value={certPath}
                onPick={() => pick('pemCert', setCertPath)}
              />
              <FilePickerRow
                label={t('certificates.form.client.keyFile')}
                value={keyPath}
                onPick={() => pick('pemKey', setKeyPath)}
              />
            </>
          ) : (
            <FilePickerRow
              label={t('certificates.form.client.pfxFile')}
              value={pfxPath}
              onPick={() => pick('pfx', setPfxPath)}
            />
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('certificates.form.client.passphrase')}
            </label>
            <PassphraseInput
              scope={scope}
              value={passphrase}
              onChange={setPassphrase}
              variables={variables}
            />
            {showPassphraseWarning && (
              <p className="mt-1 text-xs text-warning-text">
                {t('certificates.form.client.passphraseWarning', { example: '{{varName}}' })}
              </p>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('certificates.actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {t('certificates.actions.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Edit client cert dialog ────────────────────────────────────────────────

function EditClientForm({
  scope,
  entry,
  onClose
}: {
  scope: TlsScope
  entry: ClientCertEntry
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const updateClient = useCertificateStore((s) => s.updateClient)
  const variables = useActiveEnvironmentVariables()
  const [host, setHost] = useState(entry.host)
  const [port, setPort] = useState(entry.port != null ? String(entry.port) : '')
  const [passphrase, setPassphrase] = useState(entry.passphrase ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const showPassphraseWarning = useMemo(
    () =>
      scope === 'workspace' &&
      passphrase.trim().length > 0 &&
      !isCompleteVariableReference(passphrase),
    [scope, passphrase]
  )

  async function handleSubmit(): Promise<void> {
    setError(null)
    if (!host.trim()) {
      setError(t('certificates.errors.hostRequired'))
      return
    }
    if (scope === 'app' && containsVariableReference(passphrase)) {
      setError(t('certificates.errors.passphraseVariableNotAllowed'))
      return
    }
    const parsedPort = parsePortField(port)
    if (parsedPort === undefined) {
      setError(t('certificates.errors.invalidPort'))
      return
    }
    setSubmitting(true)
    try {
      await updateClient({
        scope,
        id: entry.id,
        patch: {
          host: host.trim(),
          port: parsedPort,
          passphrase: passphrase.trim() ? passphrase : null
        }
      })
      onClose()
    } catch (err) {
      setError(certificateErrorText(err, 'save', t))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('certificates.form.client.editTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('certificates.form.client.host')}
              </label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={t('certificates.form.client.hostPlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('certificates.form.client.port')}
              </label>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={t('certificates.form.client.portPlaceholder')}
                className="w-24"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('certificates.form.client.passphrase')}
            </label>
            <PassphraseInput
              scope={scope}
              value={passphrase}
              onChange={setPassphrase}
              variables={variables}
            />
            {showPassphraseWarning && (
              <p className="mt-1 text-xs text-warning-text">
                {t('certificates.form.client.passphraseWarning', { example: '{{varName}}' })}
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {t('certificates.form.client.filesImmutableNote')}
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('certificates.actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {t('certificates.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Building blocks ────────────────────────────────────────────────────────

function SectionHeader({
  title,
  intro,
  action
}: {
  title: string
  intro: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="mb-2 flex items-start justify-between gap-3">
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{intro}</p>
      </div>
      {action}
    </header>
  )
}

/** A remove or enable toggle the store refused, under the section's table. */
function RowError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <p role="alert" className="mt-2 text-xs text-destructive">
      {message}
    </p>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded border border-dashed border-border-default px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function TableShell({
  headers,
  children
}: {
  headers: string[]
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded border border-border-default">
      <table className="w-full">
        <thead>
          <tr className="bg-muted/40">
            {headers.map((h) => (
              <th
                key={h}
                className="px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function FilePickerRow({
  label,
  value,
  placeholder,
  onPick
}: {
  label: string
  value: string
  placeholder?: string
  onPick: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <Input value={value} readOnly placeholder={placeholder} className="font-mono text-xs" />
        <Button type="button" variant="outline" size="sm" onClick={onPick}>
          <FolderOpen className="mr-1 h-3 w-3" />
          {t('certificates.form.client.pickFile')}
        </Button>
      </div>
    </div>
  )
}
