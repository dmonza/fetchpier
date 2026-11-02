import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, KeyRound } from 'lucide-react'
import { useSecretsStore } from '../../stores/secrets'
import { formatRelative } from '../../lib/relative-time'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { AddWorkspaceKeyDialog } from './AddWorkspaceKeyDialog'
import { DeleteWorkspaceKeyDialog } from './DeleteWorkspaceKeyDialog'
import type { WorkspaceKeyMetadata, WorkspaceKeyReferences } from '../../../shared/types'

/**
 * REQ-0073 — the Workspace keys tab. Lists the machine-local keystore (metadata
 * only — never key material), with an honest reference mark, and offers delete
 * and proactive add. Opening it reads metadata only and never prompts.
 */
export function WorkspaceKeysPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const keys = useSecretsStore((s) => s.keys)
  const references = useSecretsStore((s) => s.references)
  const loading = useSecretsStore((s) => s.keysLoading)
  const listKeys = useSecretsStore((s) => s.listKeys)

  const [addOpen, setAddOpen] = useState(false)
  const [deleting, setDeleting] = useState<WorkspaceKeyMetadata | null>(null)

  useEffect(() => {
    void listKeys()
  }, [listKeys])

  const degraded = keys.some((k) => k.backing === 'session-only')

  return (
    <div className="px-4 py-4 space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('workspaceKeys.heading')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('workspaceKeys.intro')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1 h-3 w-3" />
          {t('workspaceKeys.add.action')}
        </Button>
      </header>

      {degraded && (
        <p className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
          {t('workspaceKeys.degradedNotice')}
        </p>
      )}

      {keys.length === 0 ? (
        <div className="rounded border border-dashed border-border-default px-3 py-6 text-center text-xs text-muted-foreground">
          <KeyRound className="mx-auto mb-2 h-5 w-5 opacity-60" />
          <p>{loading ? t('workspaceKeys.loading') : t('workspaceKeys.empty')}</p>
        </div>
      ) : (
        <TooltipProvider>
          <div className="overflow-hidden rounded border border-border-default">
            <table className="w-full">
              <thead>
                <tr className="bg-muted/40">
                  {[
                    t('workspaceKeys.table.workspace'),
                    t('workspaceKeys.table.keyId'),
                    t('workspaceKeys.table.lastUsed'),
                    t('workspaceKeys.table.status'),
                    t('workspaceKeys.table.storage'),
                    t('workspaceKeys.table.actions')
                  ].map((h) => (
                    <th
                      key={h}
                      className="px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((entry) => (
                  <KeyRow
                    key={entry.keyId}
                    entry={entry}
                    references={references}
                    onDelete={() => setDeleting(entry)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </TooltipProvider>
      )}

      {addOpen && <AddWorkspaceKeyDialog onClose={() => setAddOpen(false)} />}
      {deleting && (
        <DeleteWorkspaceKeyDialog
          entry={deleting}
          usedBy={references?.byKeyId[deleting.keyId]}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

function KeyRow({
  entry,
  references,
  onDelete
}: {
  entry: WorkspaceKeyMetadata
  references: WorkspaceKeyReferences | null
  onDelete: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const usedBy = references?.byKeyId[entry.keyId]

  return (
    <tr className="border-t border-border-default">
      <td className="px-3 py-2 text-xs text-foreground">
        {entry.workspaceHint || (
          <span className="italic text-muted-foreground">{t('workspaceKeys.unnamed')}</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{entry.keyId}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {formatRelative(entry.lastUsedAt, i18n.language)}
      </td>
      <td className="px-3 py-2 text-xs">
        <ReferenceMark usedBy={usedBy} incomplete={references?.incomplete ?? false} />
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {entry.backing === 'os-keychain'
          ? t('workspaceKeys.storage.stored')
          : t('workspaceKeys.storage.session')}
      </td>
      <td className="px-3 py-2 text-xs">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3 w-3" />
          {t('workspaceKeys.actions.delete')}
        </button>
      </td>
    </tr>
  )
}

/**
 * The honest three-state mark (REQ-0073 §5.2): "In use" naming workspaces,
 * "Not referenced" (never "invalid/unused"), and "Could not check" when a known
 * workspace was unreadable. The mark gates nothing.
 */
function ReferenceMark({
  usedBy,
  incomplete
}: {
  usedBy: string[] | undefined
  incomplete: boolean
}): React.JSX.Element {
  const { t } = useTranslation()

  if (usedBy && usedBy.length > 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default text-primary">{t('workspaceKeys.mark.inUse')}</span>
        </TooltipTrigger>
        <TooltipContent>
          {t('workspaceKeys.mark.inUseTooltip', { names: usedBy.join(', ') })}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (incomplete) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default text-muted-foreground">
            {t('workspaceKeys.mark.couldNotCheck')}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('workspaceKeys.mark.couldNotCheckTooltip')}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-muted-foreground">
          {t('workspaceKeys.mark.notReferenced')}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('workspaceKeys.mark.notReferencedTooltip')}</TooltipContent>
    </Tooltip>
  )
}
