import { Fragment, Suspense, lazy, useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  SlidersHorizontal,
  Plus,
  Trash2,
  ChevronDown,
  GripVertical,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  RotateCcw,
  AlertTriangle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useSortableRow } from '../ui/sortable-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { useEnvironmentStore } from '../../stores/environment'
import { useSecretsStore } from '../../stores/secrets'
import { useToastStore } from '../../stores/toast'
import type {
  EnvironmentLocalView,
  EnvironmentLocalViewRow,
  SecretsSetupResult,
  SecretsStatus
} from '../../../shared/types'
import { SecretSetupDialog } from './SecretSetupDialog'
import { EnterKeyDialog } from './EnterKeyDialog'
import { RotateKeyDialog } from './RotateKeyDialog'
import { EnvironmentList } from './EnvironmentList'
import { buildEnvironmentListView } from '../../lib/environment-list-view'
import { isReservedVariableName } from '../../../shared/lib/dynamic-variables'
import {
  RESERVED_PREFIX,
  commitMaterialization,
  computeEnvEntries,
  envEntriesToVariables,
  materializeVariable,
  newRow,
  orderEnvEntries,
  variablesToRows,
  type VarRow
} from '../../lib/environment-variables'

// ── Inline editable variables table ────────────────────────────────────────

// The ordering / serialization / materialization model lives in
// `renderer/lib/environment-variables.ts` (unit-tested there); this file keeps
// rendering and I/O.

// dnd-kit behind a lazy import so it is code-split out of the initial bundle (REQ-0079).
const SortableRows = lazy(() => import('../ui/SortableRows'))

interface EnvRowNode {
  id: string
  node: React.ReactNode
}

/**
 * Row shell shared by every variable row variant. Renders a leading drag handle when
 * inside a sortable list (REQ-0079) — read from {@link useSortableRow} — or a width
 * spacer otherwise (unshared rows, single-row tables), so all rows and the header
 * keep their column alignment. The 5-column {@link ROW_GRID} stays the inner grid.
 *
 * `accent` (REQ-0108 §6.3) marks an unshared row. The bar occupies the handle slot,
 * which such a row leaves empty by definition — it lands on the row's leading edge
 * without stealing width from any column. Colour is never the only channel: the row's
 * name carries the explanatory tooltip.
 *
 * Deliberately *no* row background: the tinted background is reserved for secret rows
 * (`bg-primary/5`), so one colour channel carries one meaning. A second tint here read
 * as noise competing with it and added no signal the bar was not already giving.
 */
function EnvRowShell({
  className,
  accent,
  children
}: {
  className?: string
  accent?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const sortable = useSortableRow()
  return (
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      className={cn(
        'group flex items-center border-b border-border',
        className,
        sortable?.isDragging && 'relative z-10 shadow-sm'
      )}
    >
      {sortable ? (
        <button
          type="button"
          className="flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground opacity-30 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none active:cursor-grabbing"
          aria-label={t('keyValue.dragHandle')}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      ) : accent ? (
        <span className="flex w-5 shrink-0 justify-center" aria-hidden>
          <span className="h-5 w-[3px] rounded-full bg-primary" />
        </span>
      ) : (
        <span className="w-5 shrink-0" aria-hidden />
      )}
      <div className={cn(ROW_GRID, 'min-w-0 flex-1 px-3 py-1')}>{children}</div>
    </div>
  )
}

/** Static (non-draggable) render of the row nodes — the Suspense fallback and the ≤1-row case. */
function EnvStaticList({ rows }: { rows: EnvRowNode[] }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {rows.map((r) => (
        <Fragment key={r.id}>{r.node}</Fragment>
      ))}
    </div>
  )
}

// ── Sync check (REQ-0075: the per-variable "follow the team" gesture) ────────

interface SyncCheckProps {
  checked: boolean
  disabled?: boolean
  onToggle: (checked: boolean) => void
}

/**
 * The per-row Sync check. Checked ⇔ the variable follows the shared layer (no
 * local entry). Unchecking diverges (seeds a local entry); re-checking returns to
 * following the team. State is derived from the model, never stored.
 */
function SyncCheck({ checked, disabled, onToggle }: SyncCheckProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <label
      className="flex min-w-0 shrink-0 items-center gap-1 select-none"
      title={t('environment.local.syncTooltip')}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={t('environment.local.sync')}
        className="h-3.5 w-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
      />
      <span className="text-[10px] text-muted-foreground">{t('environment.local.sync')}</span>
    </label>
  )
}

// ── Local value cell (REQ-0074: the "Local" column) ─────────────────────────

interface LocalCellProps {
  name: string
  isSecret: boolean
  /**
   * REQ-0075: the row follows the shared layer (Sync checked). The cell renders
   * read-only — the only path to divergence is unchecking Sync, never typing.
   */
  synced: boolean
  /** Shown read-only when `synced`: the shared value (plain) or `••••••` (secret). */
  sharedValueDisplay?: string
  hasOverride: boolean
  orphan: boolean
  invalid: boolean
  /** Masked/raw local display from the view (raw for plain, masked for secret). */
  localDisplay?: string
  /** Revealed plaintext for a secret local override, when the user revealed it. */
  revealed?: string
  locked: boolean
  /** Focus the editable input on mount (after unchecking Sync seeds the entry). */
  autoFocus?: boolean
  /** Called when the editable input gains focus — lets the parent release the seed-focus flag. */
  onFocused?: () => void
  onCommit: (name: string, value: string) => void
  onReveal: (name: string) => void
  onHideReveal: (name: string) => void
}

/**
 * One cell of the Local column. When `synced` it is a read-only display of the
 * shared value (resolution fallback). When diverged: plain names edit inline;
 * secret names mask and gate reveal. Returning to shared is the Sync check, not a
 * clear button (REQ-0075 — no duplicate resync affordance).
 */
function LocalValueCell(props: LocalCellProps): React.JSX.Element {
  const { t } = useTranslation()
  const {
    name,
    isSecret,
    synced,
    sharedValueDisplay,
    hasOverride,
    orphan,
    invalid,
    localDisplay,
    revealed,
    locked,
    autoFocus,
    onFocused,
    onCommit,
    onReveal,
    onHideReveal
  } = props

  // The local state (override / orphan / invalid) reads as a colored accent bar to the left
  // of the field instead of an inline text chip, so it never steals width from the value the
  // user edits. Precedence invalid > orphan > override — one accent per cell. A dedicated
  // `bg-*` element is used (not a `border-l-*` on the input) because the input already carries
  // `border border-border` and the border-color shorthand wins the cascade over a left-border
  // utility. The label survives as a tooltip (hover/pointer) and an sr-only node (screen
  // readers) so the meaning is never color-only (WCAG 1.4.1).
  const accent = invalid
    ? { bar: 'bg-destructive', label: t('environment.local.invalid') }
    : orphan
      ? { bar: 'bg-warning', label: t('environment.local.orphan') }
      : hasOverride
        ? { bar: 'bg-primary', label: t('environment.local.override') }
        : null
  const accentBar = accent ? (
    <span aria-hidden className={cn('h-5 w-[3px] shrink-0 rounded-full', accent.bar)} />
  ) : null
  const accentLabel = accent ? <span className="sr-only">{accent.label}</span> : null

  // Synced (Sync checked): read-only fallback to the shared value. Visually muted
  // and italic, so it never reads as an editable field (CA-09).
  if (synced) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className="flex-1 truncate px-2 text-xs italic text-muted-foreground/60">
          {sharedValueDisplay ?? ''}
        </span>
      </div>
    )
  }

  if (!isSecret) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {accentBar}
        <input
          key={`local-${name}-${localDisplay ?? ''}`}
          type="text"
          defaultValue={localDisplay ?? ''}
          autoFocus={autoFocus}
          onFocus={() => onFocused?.()}
          onBlur={(e) => {
            const next = e.target.value
            if (next !== (localDisplay ?? '')) onCommit(name, next)
          }}
          placeholder={t('environment.local.placeholder')}
          title={accent?.label}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {accentLabel}
      </div>
    )
  }

  // Secret-named local cell.
  if (revealed !== undefined) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <input
          key={`local-secret-revealed-${name}`}
          type="text"
          defaultValue={revealed}
          autoFocus
          onBlur={(e) => {
            const next = e.target.value
            if (next !== revealed) onCommit(name, next)
            onHideReveal(name)
          }}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={() => onHideReveal(name)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={t('secrets.reveal')}
        >
          <EyeOff className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  if (hasOverride) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {accentBar}
        <span
          title={accent?.label}
          className="flex-1 select-none px-2 font-mono text-xs text-muted-foreground"
        >
          {localDisplay ?? '••••••••'}
        </span>
        {accentLabel}
        <button
          onClick={() => onReveal(name)}
          disabled={locked}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label={t('secrets.reveal')}
          title={t('secrets.reveal')}
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  // Diverged secret with no value yet (orphan/invalid recovery, or a needs-value
  // entry just begun) — let the user type a personal value (encrypted on write).
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {accentBar}
      <input
        key={`local-secret-set-${name}-${orphan ? 'orphan' : ''}`}
        type="text"
        defaultValue=""
        disabled={locked}
        autoFocus={autoFocus}
        onFocus={() => onFocused?.()}
        onBlur={(e) => {
          if (e.target.value) onCommit(name, e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.currentTarget.value) onCommit(name, e.currentTarget.value)
        }}
        placeholder={t('environment.local.setSecretPlaceholder')}
        title={accent?.label}
        className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring"
      />
      {accentLabel}
    </div>
  )
}

// ── Modal component ─────────────────────────────────────────────────────────

/** Masked stand-in for a secret value in the read-only Local cell and confirmations. */
const SECRET_MASK = '••••••'

/**
 * The shared 5-column grid for the variables table: Name | Shared | Sync | Local | actions.
 * Every row variant (plain, secret, local-only) and the header use this exact template so the
 * columns line up regardless of content. The fr tracks resolve to the same fraction in every
 * (full-width) row; the Sync and actions tracks are fixed px. `minmax(0,…)` lets the fr cells
 * shrink so their inner `min-w-0` inputs can truncate. The Sync track is wide enough for the
 * longest locale label ("Sincronizar"). Do not size Sync/actions by content (`auto`): each row
 * is its own grid container, so content-sized tracks would drift between rows.
 */
const ROW_GRID =
  'grid grid-cols-[minmax(0,3fr)_minmax(0,4fr)_92px_minmax(0,5fr)_56px] items-center gap-1'

/** What the re-check confirmation needs to state the consequence in values. */
interface RecheckInfo {
  name: string
  isSecret: boolean
  /** The shared value the variable returns to (masked for secrets). */
  sharedDisplay: string
  /** The local value being discarded (masked for secrets). */
  localDisplay: string
  /** Shared is `null` — re-checking returns the variable to needs-value. */
  sharedIsNull: boolean
  /** A script in this environment wrote this variable this session (informational hint). */
  scriptHint: boolean
  /**
   * REQ-0108 — the row has no entry in `config.json` yet. Confirming materializes the
   * name with the Shared cell's content before clearing the local entry (§6.6/§6.8).
   */
  unshared?: boolean
  /** The value returned to is empty — the confirmation says so explicitly (§10 Q2). */
  emptyDestination?: boolean
}

interface ModalProps {
  onClose: () => void
}

/** Exported for component tests (REQ-0108); the app mounts it through `EnvironmentManager`. */
export function EnvironmentEditorModal({ onClose }: ModalProps): React.JSX.Element {
  const { t } = useTranslation()
  const {
    environments,
    activeEnvironmentId,
    createEnvironment,
    renameEnvironment,
    duplicateEnvironment,
    saveEnvironment,
    deleteEnvironment,
    replaceEnvironment,
    workspacePath
    // No `setActive` here on purpose: the editor never re-points the active
    // environment. `activeEnvironmentId` is read only to decide which row the
    // panel opens on.
  } = useEnvironmentStore()
  const secretsStore = useSecretsStore()
  const pushToast = useToastStore((s) => s.push)

  // True while the list holds an open inline rename/duplicate field. Escape must
  // then close that field only — see the dialog's `onEscapeKeyDown` below.
  const [inlineEditorOpen, setInlineEditorOpen] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(activeEnvironmentId)
  const [rows, setRows] = useState<VarRow[]>(() => {
    const env = environments.find((e) => e.id === activeEnvironmentId)
    return env ? variablesToRows(env.variables) : []
  })

  // Secret-flow state.
  const [setupResult, setSetupResult] = useState<SecretsSetupResult | null>(null)
  const [showEnterKey, setShowEnterKey] = useState(false)
  const [showRotate, setShowRotate] = useState(false)
  const [gitNote, setGitNote] = useState<{
    name: string
    value: string
  } | null>(null)
  const [unsetConfirm, setUnsetConfirm] = useState<string | null>(null)
  // REQ-0077 — direct secret deletion confirmation (calibrated to reversibility).
  const [deleteSecretConfirm, setDeleteSecretConfirm] = useState<{
    name: string
    isNull: boolean
    hasLocal: boolean
  } | null>(null)
  const [pending, setPending] = useState<{
    name: string
    value: string
    /** REQ-0108 — resume into the needs-value authoring path, not the encrypt path. */
    needsValue?: boolean
  } | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [corruptNames, setCorruptNames] = useState<Set<string>>(new Set())
  /**
   * True while a make-secret flow runs (status check + first-time setup). The ref
   * drops a second click that lands before the re-render disables the lock; the
   * state disables the lock buttons.
   */
  const makeSecretBusyRef = useRef(false)
  const [makeSecretBusy, setMakeSecretBusy] = useState(false)
  const [needsValueInput, setNeedsValueInput] = useState<Record<string, string>>({})
  // REQ-0074 — local value layer (Shared | Local two-column editor).
  const [localView, setLocalView] = useState<EnvironmentLocalView | null>(null)
  const [localRevealed, setLocalRevealed] = useState<Record<string, string>>({})
  // REQ-0075 — per-variable Sync check.
  /** Names unchecked-but-not-yet-persisted (a needs-value secret awaiting input). */
  const [enteringLocal, setEnteringLocal] = useState<Set<string>>(new Set())
  /** The just-seeded name whose Local input should grab focus on next render. */
  const [focusName, setFocusName] = useState<string | null>(null)
  const [recheckConfirm, setRecheckConfirm] = useState<RecheckInfo | null>(null)
  const [syncAllConfirm, setSyncAllConfirm] = useState<string[] | null>(null)
  /** Previous local view + names a script-persist broadcast wrote this session (re-check hint). */
  const prevViewRef = useRef<EnvironmentLocalView | null>(null)
  const scriptWrittenRef = useRef<Set<string>>(new Set())
  /** REQ-0076 — plain rows whose value claims the reserved `enc:` prefix (rejected). */
  const [reservedRows, setReservedRows] = useState<Set<string>>(new Set())
  /** REQ-0087 — rows whose key begins with the reserved `$` system prefix (rejected). */
  const [reservedNameRows, setReservedNameRows] = useState<Set<string>>(new Set())
  /** REQ-0079 — the user's explicit drag order of entry ids, or `null` for natural order. */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  /**
   * REQ-0108 — the Shared cell text of each unshared row. The name has no entry in
   * `env.variables` yet, so there is no `VarRow` to bind to until it materializes.
   */
  const [sharedDraft, setSharedDraft] = useState<Record<string, string>>({})

  const selectedEnv = environments.find((e) => e.id === selectedId) ?? null
  const status = secretsStore.status
  const locked = status?.hasManifest === true && !status.unlocked

  // Re-read on open and whenever the workspace changes under the open editor: a
  // stale "unlocked" from the previous workspace would offer reveals that fail.
  useEffect(() => {
    secretsStore.refreshStatus().catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  /**
   * Surface a rejected auto-save. REQ-0111: these two flows have no Save button,
   * so a swallowed rejection left the row showing the new value as if it were
   * persisted and the edit was lost on reload with no signal anywhere. The typed
   * value is deliberately NOT reverted — discarding the user's input on top of a
   * failed write is worse than the failure itself; they keep what they wrote and
   * can retry by committing the field again.
   */
  const reportSaveFailure = (err: unknown): void => {
    pushToast(err instanceof Error ? err.message : String(err), { type: 'error' })
  }

  /**
   * Auto-save the plain variables of the currently selected environment. Secret
   * values are persisted separately (each through its own encrypted IPC write),
   * so both plain and secret edits commit the same way: as soon as the field is
   * left — there is no Save button to remember.
   */
  const saveVariables = (rowsToSave: VarRow[] = rows, env = selectedEnv): void => {
    if (!env) return
    // REQ-0076/0079: one unified map, serialized in the user's display order so an
    // edit never undoes a drag. Secret values are carried verbatim; `env:save`
    // resolves the authoritative ciphertext from disk at the position we send.
    const ordered = orderEnvEntries(computeEnvEntries(rowsToSave, env), dragOrder)
    const variables = envEntriesToVariables(ordered, env)
    saveEnvironment({ ...env, variables }).catch(reportSaveFailure)
  }

  /**
   * REQ-0079 — commit a drag reorder: remember the new entry order (drives display and
   * subsequent saves) and persist the variables map in that order. Allowed while locked
   * — reordering needs no key, and secret values stay disk-authoritative.
   */
  const handleReorderVariables = (ids: string[]): void => {
    if (!selectedEnv) return
    setDragOrder(ids)
    const ordered = orderEnvEntries(computeEnvEntries(rows, selectedEnv), ids)
    const variables = envEntriesToVariables(ordered, selectedEnv)
    saveEnvironment({ ...selectedEnv, variables }).catch(reportSaveFailure)
  }

  /**
   * Commit a plain variable's value, rejecting the reserved `enc:` prefix inline
   * (REQ-0076 / CA-03): a plain value may not masquerade as ciphertext. Nothing is
   * persisted while the value is reserved.
   */
  const handleVarValueBlur = (row: VarRow): void => {
    if (row.value.startsWith(RESERVED_PREFIX)) {
      setReservedRows((prev) => new Set(prev).add(row.id))
      pushToast(t('environment.local.reservedPrefix'), { type: 'error' })
      return
    }
    setReservedRows((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Set(prev)
      next.delete(row.id)
      return next
    })
    saveVariables()
  }

  /**
   * Commit a plain variable's key, rejecting the reserved `$` system prefix inline
   * (REQ-0087 / CA-06): a user name may not begin with `$` (that namespace is
   * owned by system dynamic variables). Nothing is persisted while the name is
   * reserved.
   */
  const handleVarKeyBlur = (row: VarRow): void => {
    if (isReservedVariableName(row.key)) {
      setReservedNameRows((prev) => new Set(prev).add(row.id))
      pushToast(t('environment.reservedName'), { type: 'error' })
      return
    }
    setReservedNameRows((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Set(prev)
      next.delete(row.id)
      return next
    })
    saveVariables()
  }

  const handleSelectEnv = useCallback(
    (id: string | null) => {
      // Plain variables auto-save on each field's blur, and secrets through their
      // own IPC writes; switching needs no explicit flush here (and must not fire
      // a competing `env:save` that could race a just-triggered secret write).
      setSelectedId(id)
      const env = environments.find((e) => e.id === id)
      setRows(env ? variablesToRows(env.variables) : [])
      setDragOrder(null)
      setRevealed({})
      setCorruptNames(new Set())
      // REQ-0075 — reset per-environment Sync session state.
      setEnteringLocal(new Set())
      setFocusName(null)
      setReservedRows(new Set())
      setReservedNameRows(new Set())
      setSharedDraft({})
      scriptWrittenRef.current = new Set()
      prevViewRef.current = null
    },
    [environments]
  )

  // ── Local value layer (REQ-0074) ──────────────────────────────────────────

  const loadLocalView = useCallback(
    async (envId: string | null): Promise<void> => {
      if (!envId) {
        setLocalView(null)
        prevViewRef.current = null
        return
      }
      try {
        const view = await window.api.localValues.getView(envId)
        setLocalView(view)
        // Keep the script-write diff baseline current so a later broadcast compares
        // against the freshest editor state, not a stale snapshot.
        prevViewRef.current = view
        if (view.orphanNotice && view.orphanNotice.variables.length > 0) {
          pushToast(
            t('environment.local.orphanNotice', {
              names: view.orphanNotice.variables.join(', ')
            }),
            { type: 'info' }
          )
        }
      } catch (err) {
        console.error('[EnvironmentManager] failed to load local view:', err)
      }
    },
    [pushToast, t]
  )

  // Load the local layer for the selected environment, and refresh whenever a
  // script write / orphan cleanup broadcasts a change from the main process.
  // The state lands only after the async IPC resolves (never synchronously in
  // the effect body), so this does not cascade renders.
  useEffect(() => {
    let active = true
    const refresh = async (fromBroadcast: boolean): Promise<void> => {
      if (!selectedId) {
        await Promise.resolve()
        if (active) {
          setLocalView(null)
          prevViewRef.current = null
        }
        return
      }
      try {
        const view = await window.api.localValues.getView(selectedId)
        if (!active) return
        // A broadcast fires only on a script-persist / orphan-cleanup write (the
        // editor's own set/clear/seed refresh directly). Names whose override
        // appeared or changed across such a broadcast were written by a script —
        // the cheap session signal behind the re-check hint (§4 assumption).
        if (fromBroadcast && prevViewRef.current) {
          const before = new Map(prevViewRef.current.rows.map((r) => [r.name, r]))
          for (const r of view.rows) {
            const prev = before.get(r.name)
            if (
              r.hasLocalOverride &&
              (!prev?.hasLocalOverride || prev.localDisplay !== r.localDisplay)
            ) {
              scriptWrittenRef.current.add(r.name)
            }
          }
        }
        setLocalView(view)
        prevViewRef.current = view
        if (view.orphanNotice && view.orphanNotice.variables.length > 0) {
          pushToast(
            t('environment.local.orphanNotice', {
              names: view.orphanNotice.variables.join(', ')
            }),
            { type: 'info' }
          )
        }
      } catch (err) {
        console.error('[EnvironmentManager] failed to load local view:', err)
      }
    }
    void refresh(false)
    const off = window.api.localValues.onChanged((payload) => {
      if (payload.environmentId === selectedId) void refresh(true)
    })
    return () => {
      active = false
      off()
    }
  }, [selectedId, pushToast, t])

  const localByName = new Map((localView?.rows ?? []).map((r) => [r.name, r]))
  /**
   * REQ-0108 — rows holding a local value with no entry in `config.json`. They render
   * as ordinary rows at the end of the list (the view already sorts them by name);
   * they are the only rows without a drag handle, because they have no slot in the
   * shared file to persist an order into.
   */
  const unsharedRows = (localView?.rows ?? []).filter((r) => r.localOnly)

  const dropEntering = (name: string): void =>
    setEnteringLocal((prev) => {
      if (!prev.has(name)) return prev
      const next = new Set(prev)
      next.delete(name)
      return next
    })

  /** Set or clear a single local value (empty clears the override). */
  const handleSetLocal = async (name: string, value: string): Promise<void> => {
    if (!selectedEnv || !name.trim()) return
    try {
      if (value === '') await window.api.localValues.clear(selectedEnv.id, name)
      else await window.api.localValues.set(selectedEnv.id, name, value)
      dropEntering(name) // a persisted entry now derives the unchecked state on its own
      await loadLocalView(selectedEnv.id)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  // ── Materialization of an unshared variable (REQ-0108) ────────────────────

  /**
   * Give an unshared variable an entry in the shared environment file. The shared
   * write commits before any local clear (§6.8), so a failed write can never destroy
   * the only copy of a value. Returns `false` when nothing was written.
   */
  const materializeUnshared = async (
    name: string,
    sharedValue: string,
    opts: { clearLocal: boolean }
  ): Promise<boolean> => {
    if (!selectedEnv) return false
    const res = materializeVariable(rows, selectedEnv, dragOrder, name, sharedValue)
    if (!res.ok) {
      pushToast(
        res.reason === 'reserved-name'
          ? t('environment.reservedName')
          : t('environment.local.reservedPrefix'),
        { type: 'error' }
      )
      return false
    }
    try {
      await commitMaterialization({
        saveShared: () => saveEnvironment({ ...selectedEnv, variables: res.variables }),
        clearLocal: opts.clearLocal
          ? () => window.api.localValues.clear(selectedEnv.id, name)
          : undefined
      })
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
      return false
    }
    setRows(res.rows)
    setSharedDraft((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    await loadLocalView(selectedEnv.id)
    return true
  }

  /**
   * Commit the Shared cell of an unshared row (§6.5): the name reaches the team's
   * file with the typed value and the local override is left alone — it keeps winning
   * resolution. An empty cell is not a gesture: blurring an untouched field must not
   * write anything (§6.7).
   */
  const handleUnsharedSharedBlur = async (name: string): Promise<void> => {
    const value = sharedDraft[name] ?? ''
    if (value === '') return
    await materializeUnshared(name, value, { clearLocal: false })
  }

  // ── Sync check gestures (REQ-0075) ────────────────────────────────────────

  /** Uncheck Sync: diverge. Seeds the entry with the shared value (CA-02), except
   * a needs-value secret which opens an empty input without persisting yet (§6.2). */
  const handleUncheckSync = async (
    name: string,
    isSecret: boolean,
    sharedIsNull: boolean
  ): Promise<void> => {
    if (!selectedEnv) return
    if (isSecret && sharedIsNull) {
      setEnteringLocal((prev) => new Set(prev).add(name))
      setFocusName(name)
      return
    }
    try {
      await window.api.localValues.seed(selectedEnv.id, name)
      setFocusName(name)
      await loadLocalView(selectedEnv.id)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  /** Re-check Sync: return to following shared. Silent when identical/recovery,
   * confirmed when the local value diverges (§6.3, CA-03/CA-04/CA-07). */
  const handleRecheckSync = async (info: {
    name: string
    isSecret: boolean
    orphan: boolean
    invalid: boolean
    divergent: boolean
    sharedIsNull: boolean
    sharedDisplay: string
    localDisplay: string
  }): Promise<void> => {
    if (!selectedEnv) return
    // A needs-value entry that was never persisted: just cancel it.
    if (enteringLocal.has(info.name)) {
      dropEntering(info.name)
      return
    }
    // Orphan/invalid recovery, or an identical (seeded) value: clear silently.
    if (info.orphan || info.invalid || !info.divergent) {
      await handleClearLocal(info.name)
      return
    }
    setRecheckConfirm({
      name: info.name,
      isSecret: info.isSecret,
      sharedDisplay: info.sharedDisplay,
      localDisplay: info.localDisplay,
      sharedIsNull: info.sharedIsNull,
      scriptHint: scriptWrittenRef.current.has(info.name)
    })
  }

  /** Confirm the divergent re-check: discard the local value, follow shared again. */
  const handleConfirmRecheck = async (): Promise<void> => {
    const info = recheckConfirm
    setRecheckConfirm(null)
    if (!info) return
    // REQ-0108 §6.6 — an unshared row has no shared entry to return to yet, so the
    // name is materialized with the Shared cell's content first, then the local
    // entry is discarded. Same rule as every other row: follow the shared value.
    if (info.unshared) {
      await materializeUnshared(info.name, info.sharedDisplay, {
        clearLocal: true
      })
      return
    }
    await handleClearLocal(info.name)
  }

  /** Check Sync on an unshared row: always confirmed — a real value is being discarded. */
  const handleUnsharedSync = (r: EnvironmentLocalViewRow): void => {
    const destination = sharedDraft[r.name] ?? ''
    setRecheckConfirm({
      name: r.name,
      isSecret: false,
      sharedDisplay: destination,
      localDisplay: r.localDisplay ?? '',
      sharedIsNull: false,
      scriptHint: scriptWrittenRef.current.has(r.name),
      unshared: true,
      emptyDestination: destination === ''
    })
  }

  /** Bulk "Sync all": clear every diverged override after one aggregate confirm (Q1). */
  const handleSyncAll = async (): Promise<void> => {
    if (!selectedEnv || !syncAllConfirm) return
    const names = syncAllConfirm
    setSyncAllConfirm(null)
    try {
      for (const name of names) {
        await window.api.localValues.clear(selectedEnv.id, name)
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    } finally {
      await loadLocalView(selectedEnv.id)
    }
  }

  /** Names that currently diverge from shared (drive the Sync-all button + dialog). */
  const divergedNames = (localView?.rows ?? [])
    .filter((r) => !r.localOnly && (r.hasLocalOverride || r.orphan || r.invalid))
    .map((r) => r.name)

  const handleClearLocal = async (name: string): Promise<void> => {
    if (!selectedEnv) return
    try {
      await window.api.localValues.clear(selectedEnv.id, name)
      setLocalRevealed((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      await loadLocalView(selectedEnv.id)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  const handleRevealLocal = async (name: string): Promise<void> => {
    if (!selectedEnv) return
    try {
      const plaintext = await window.api.localValues.reveal(selectedEnv.id, name)
      setLocalRevealed((prev) => ({ ...prev, [name]: plaintext }))
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  const handleRowChange = (id: string, field: 'key' | 'value', value: string): void => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)))
  }

  const handleAddRow = (): void => {
    setRows((prev) => [...prev, newRow()])
  }

  const handleRemoveRow = (id: string): void => {
    const removed = rows.find((r) => r.id === id)
    const next = rows.filter((r) => r.id !== id)
    setRows(next)
    saveVariables(next)
    // REQ-0108 §6.9 — deletion spans both layers. Without this the local override
    // survives the shared deletion and the name returns as an unshared row on the
    // next load. (The secret path already deletes both — this brings plain to parity.)
    const name = removed?.key.trim()
    if (name && selectedEnv) {
      const envId = selectedEnv.id
      window.api.localValues
        .clear(envId, name)
        .then(() => loadLocalView(envId))
        .catch(console.error)
    }
  }

  // ── Secret operations ─────────────────────────────────────────────────────

  const finishMakeSecret = async (name: string, value: string): Promise<void> => {
    if (!selectedEnv) return
    try {
      const updated = await secretsStore.setSecret(selectedEnv.id, name, value)
      replaceEnvironment(updated)
      setRows((prev) => prev.filter((r) => r.key.trim() !== name))
      setPending(null)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  /**
   * REQ-0108 §6.10 — lock an unshared variable: the shared file gains the name as a
   * needs-value secret, and the plaintext local value is encrypted in place by the
   * secrecy transition the write triggers. Locking states secrecy, not sharing: the
   * local value is never published (§6.1).
   */
  const finishAuthorNeedsValue = async (name: string): Promise<void> => {
    if (!selectedEnv) return
    try {
      const updated = await secretsStore.clearSecret(selectedEnv.id, name)
      replaceEnvironment(updated)
      setRows(variablesToRows(updated.variables))
      setSharedDraft((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      setPending(null)
      await loadLocalView(selectedEnv.id)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  /**
   * Make a variable secret, handling first-time setup / unlock / git note.
   * `needsValue` (REQ-0108) authors a needs-value secret instead of encrypting a
   * value — the path an unshared row takes, since it has no shared value to encrypt.
   */
  const handleMakeSecret = async (
    name: string,
    value: string,
    needsValue = false
  ): Promise<void> => {
    // A `$` name is the reserved system namespace: it can never be a secret.
    if (!name.trim() || isReservedVariableName(name) || !selectedEnv) return
    // A double click must not run first-time setup twice (two keys minted).
    if (makeSecretBusyRef.current) return
    makeSecretBusyRef.current = true
    setMakeSecretBusy(true)
    let current: SecretsStatus
    try {
      current = await secretsStore.refreshStatus()
      if (!current.hasManifest) {
        try {
          const result = await secretsStore.setup()
          setPending({ name, value, needsValue })
          setSetupResult(result)
        } catch (err) {
          pushToast(err instanceof Error ? err.message : String(err), {
            type: 'error'
          })
        }
        return
      }
    } finally {
      makeSecretBusyRef.current = false
      setMakeSecretBusy(false)
    }
    if (!current.unlocked) {
      setPending({ name, value, needsValue })
      setShowEnterKey(true)
      return
    }
    if (needsValue) {
      await finishAuthorNeedsValue(name)
      return
    }
    if (value.trim() !== '') {
      setGitNote({ name, value })
      return
    }
    await finishMakeSecret(name, value)
  }

  const handleReveal = async (name: string): Promise<void> => {
    if (!selectedEnv) return
    try {
      const plaintext = await secretsStore.reveal(selectedEnv.id, name)
      setRevealed((prev) => ({ ...prev, [name]: plaintext }))
    } catch (err) {
      // Classified on the error code main puts at the head of the message: only a
      // corrupt value offers "Clear and re-enter", which overwrites the ciphertext.
      // A missing key (stale status) leaves the ciphertext valid — unlock instead.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('SECRETS_VALUE_CORRUPT')) {
        setCorruptNames((prev) => new Set(prev).add(name))
      } else if (msg.includes('SECRETS_KEY_MISSING')) {
        await secretsStore.refreshStatus()
        setShowEnterKey(true)
      } else {
        pushToast(msg, { type: 'error' })
      }
    }
  }

  /** Persist an edit to an already-revealed secret value (auto-save on blur). */
  const handleEditRevealed = async (name: string, value: string): Promise<void> => {
    if (!selectedEnv) return
    try {
      const updated = await secretsStore.setSecret(selectedEnv.id, name, value)
      replaceEnvironment(updated)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  /** Persist the value typed into a needs-value secret (auto-save on blur/Enter). */
  const handleEnterNeedsValue = async (name: string): Promise<void> => {
    const value = needsValueInput[name] ?? ''
    if (!value) return
    await finishMakeSecret(name, value)
    setNeedsValueInput((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  const handleUnsetSecret = async (name: string): Promise<void> => {
    if (!selectedEnv) return
    setUnsetConfirm(null)
    try {
      const updated = await secretsStore.unsetSecret(selectedEnv.id, name)
      replaceEnvironment(updated)
      setRows(variablesToRows(updated.variables))
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  /**
   * REQ-0077 — delete a secret directly (no make-plain, no plaintext). Removes the
   * shared entry and any local override in one IPC call, then refreshes the local
   * view so the removed override disappears from the Local column.
   */
  const handleDeleteSecret = async (name: string): Promise<void> => {
    if (!selectedEnv) return
    setDeleteSecretConfirm(null)
    try {
      const updated = await secretsStore.deleteSecret(selectedEnv.id, name)
      replaceEnvironment(updated)
      setRows(variablesToRows(updated.variables))
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      await loadLocalView(selectedEnv.id)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  const handleClearSecret = async (name: string): Promise<void> => {
    if (!selectedEnv) return
    try {
      const updated = await secretsStore.clearSecret(selectedEnv.id, name)
      replaceEnvironment(updated)
      setCorruptNames((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), {
        type: 'error'
      })
    }
  }

  // The list surfaces every naming rejection itself (it holds the inline field
  // the user has to correct), so these deliberately let the error propagate.
  const handleCreate = async (name: string): Promise<void> => {
    const env = await createEnvironment(name)
    handleSelectEnv(env.id)
  }

  const handleRename = async (envId: string, newName: string): Promise<void> => {
    // The identifier is stable across a rename, so nothing about the selection
    // or the loaded variables changes — the row simply relabels.
    await renameEnvironment(envId, newName)
  }

  const handleDuplicate = async (sourceEnvId: string, newName: string): Promise<void> => {
    const copy = await duplicateEnvironment(sourceEnvId, newName)
    // Consistent with creating: the copy becomes the selected environment.
    handleSelectEnv(copy.id)
  }

  const handleDelete = async (envId: string): Promise<void> => {
    await deleteEnvironment(envId)
    if (selectedId === envId) {
      const remaining = environments.filter((e) => e.id !== envId)
      handleSelectEnv(remaining[0]?.id ?? null)
    }
  }

  const handleClose = (): void => {
    // No explicit flush: plain variables auto-save on each field's blur (closing
    // the dialog restores focus to the trigger, firing that blur), and secrets
    // persist through their own writes. Avoiding an `env:save` here keeps it from
    // racing a secret write triggered by the same close.
    //
    // The panel is an **editor, not a selector**: which environment is active is
    // the user's call and is made through the toolbar dropdown alone. Closing this
    // dialog must never re-point it — browsing another environment's variables
    // would otherwise silently change which one the next send resolves against.
    onClose()
  }

  // REQ-0079: plain + secret variables as one drag-reorderable list in map order.
  const unifiedEntries = orderEnvEntries(computeEnvEntries(rows, selectedEnv), dragOrder)

  // ── Row cell renderers (the inner ROW_GRID cells; EnvRowShell wraps each) ──

  const renderPlainCells = (row: VarRow): React.JSX.Element => {
    const key = row.key.trim()
    const lr = key ? localByName.get(key) : undefined
    const hasEntry = !!lr && (lr.hasLocalOverride || lr.orphan || lr.invalid)
    const entering = enteringLocal.has(key)
    const isSynced = !!key && !hasEntry && !entering
    return (
      <>
        <input
          type="text"
          value={row.key}
          onChange={(e) => handleRowChange(row.id, 'key', e.target.value)}
          onBlur={() => handleVarKeyBlur(row)}
          placeholder={t('environment.keyPlaceholder')}
          title={reservedNameRows.has(row.id) ? t('environment.reservedName') : undefined}
          className={cn(
            'h-7 min-w-0 rounded border bg-transparent px-2 text-xs placeholder:text-muted-foreground/50 focus:outline-none',
            reservedNameRows.has(row.id)
              ? 'border-destructive focus:border-destructive'
              : 'border-transparent focus:border-border'
          )}
        />
        <input
          type="text"
          value={row.value}
          onChange={(e) => handleRowChange(row.id, 'value', e.target.value)}
          onBlur={() => handleVarValueBlur(row)}
          placeholder={t('environment.valuePlaceholder')}
          title={reservedRows.has(row.id) ? t('environment.local.reservedPrefix') : undefined}
          className={cn(
            'h-7 min-w-0 rounded border bg-transparent px-2 text-xs placeholder:text-muted-foreground/50 focus:outline-none',
            reservedRows.has(row.id)
              ? 'border-destructive focus:border-destructive'
              : 'border-transparent focus:border-border'
          )}
        />
        {key ? (
          <SyncCheck
            checked={isSynced}
            onToggle={(checked) =>
              (checked
                ? handleRecheckSync({
                    name: key,
                    isSecret: false,
                    orphan: lr?.orphan ?? false,
                    invalid: lr?.invalid ?? false,
                    divergent: (lr?.localDisplay ?? '') !== row.value,
                    sharedIsNull: false,
                    sharedDisplay: row.value,
                    localDisplay: lr?.localDisplay ?? ''
                  })
                : handleUncheckSync(key, false, false)
              ).catch(console.error)
            }
          />
        ) : (
          <span aria-hidden />
        )}
        <LocalValueCell
          name={key}
          isSecret={false}
          synced={isSynced}
          sharedValueDisplay={row.value}
          hasOverride={lr?.hasLocalOverride ?? false}
          orphan={lr?.orphan ?? false}
          invalid={lr?.invalid ?? false}
          localDisplay={lr?.localDisplay}
          revealed={undefined}
          locked={locked}
          autoFocus={focusName === key}
          onFocused={() => setFocusName(null)}
          onCommit={(n, v) => handleSetLocal(n, v).catch(console.error)}
          onReveal={(n) => handleRevealLocal(n).catch(console.error)}
          onHideReveal={() => undefined}
        />
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => handleMakeSecret(row.key, row.value).catch(console.error)}
            disabled={
              !row.key.trim() ||
              isReservedVariableName(row.key) ||
              reservedNameRows.has(row.id) ||
              makeSecretBusy
            }
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-primary disabled:opacity-30"
            aria-label={t('secrets.makeSecret')}
            title={t('secrets.makeSecret')}
          >
            <Lock className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => handleRemoveRow(row.id)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive"
            aria-label={t('keyValue.remove')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </>
    )
  }

  const renderSecretCells = (name: string, value: string | null): React.JSX.Element => {
    const isNull = value === null
    const isCorrupt = corruptNames.has(name)
    const revealedValue = revealed[name]
    const lr = localByName.get(name)
    const hasEntry = !!lr && (lr.hasLocalOverride || lr.orphan || lr.invalid)
    const entering = enteringLocal.has(name)
    const isSynced = !hasEntry && !entering
    return (
      <>
        <div className="flex min-w-0 items-center gap-1.5 px-2">
          <KeyRound className="h-3 w-3 shrink-0 text-primary" />
          <span className="truncate text-xs font-medium">{name}</span>
        </div>

        {isNull ? (
          <div className="flex min-w-0 items-center gap-1">
            <span className="rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning">
              {t('secrets.needsValue')}
            </span>
            <input
              type="text"
              value={needsValueInput[name] ?? ''}
              onChange={(e) => setNeedsValueInput((p) => ({ ...p, [name]: e.target.value }))}
              onBlur={() => handleEnterNeedsValue(name).catch(console.error)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleEnterNeedsValue(name).catch(console.error)
              }}
              placeholder={t('secrets.enterValuePlaceholder')}
              disabled={locked}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        ) : isCorrupt ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              {t('secrets.corrupt')}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px]"
              onClick={() => handleClearSecret(name).catch(console.error)}
            >
              {t('secrets.clearReenter')}
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            {revealedValue !== undefined ? (
              <input
                type="text"
                defaultValue={revealedValue}
                autoFocus
                onBlur={(e) => {
                  const next = e.target.value
                  if (next !== revealedValue) handleEditRevealed(name, next).catch(console.error)
                  setRevealed((prev) => {
                    const c = { ...prev }
                    delete c[name]
                    return c
                  })
                }}
                className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            ) : (
              <span className="flex-1 select-none px-2 font-mono text-xs text-muted-foreground">
                ••••••••
              </span>
            )}
            <button
              onClick={() =>
                revealedValue !== undefined
                  ? setRevealed((prev) => {
                      const c = { ...prev }
                      delete c[name]
                      return c
                    })
                  : handleReveal(name).catch(console.error)
              }
              disabled={locked}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
              aria-label={t('secrets.reveal')}
              title={t('secrets.reveal')}
            >
              {revealedValue !== undefined ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        )}

        <SyncCheck
          checked={isSynced}
          disabled={locked}
          onToggle={(checked) =>
            (checked
              ? handleRecheckSync({
                  name,
                  isSecret: true,
                  orphan: lr?.orphan ?? false,
                  invalid: lr?.invalid ?? false,
                  divergent: lr?.divergent ?? false,
                  sharedIsNull: isNull,
                  sharedDisplay: SECRET_MASK,
                  localDisplay: SECRET_MASK
                })
              : handleUncheckSync(name, true, isNull)
            ).catch(console.error)
          }
        />
        <LocalValueCell
          name={name}
          isSecret
          synced={isSynced}
          sharedValueDisplay={isNull ? '' : SECRET_MASK}
          hasOverride={lr?.hasLocalOverride ?? false}
          orphan={lr?.orphan ?? false}
          invalid={lr?.invalid ?? false}
          localDisplay={lr?.localDisplay}
          revealed={localRevealed[name]}
          locked={locked}
          autoFocus={focusName === name}
          onFocused={() => setFocusName(null)}
          onCommit={(n, v) => handleSetLocal(n, v).catch(console.error)}
          onReveal={(n) => handleRevealLocal(n).catch(console.error)}
          onHideReveal={(n) =>
            setLocalRevealed((prev) => {
              const next = { ...prev }
              delete next[n]
              return next
            })
          }
        />

        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => setUnsetConfirm(name)}
            disabled={locked}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
            aria-label={t('secrets.makePlain')}
            title={t('secrets.makePlain')}
          >
            <Unlock className="h-3.5 w-3.5" />
          </button>
          {/* REQ-0077 — direct delete. Enabled even when locked: deletion needs no key. */}
          <button
            onClick={() => setDeleteSecretConfirm({ name, isNull, hasLocal: hasEntry })}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive"
            aria-label={t('keyValue.remove')}
            title={t('keyValue.remove')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </>
    )
  }

  /**
   * REQ-0108 — an unshared row: same shape and same actions as every other row. Its
   * Shared cell is editable (the only path a value reaches the team, §6.5) and its
   * Sync check is operable (§6.6).
   *
   * The state is carried by three things, in decreasing order of how much work each
   * does: the **Shared cell's placeholder**, which names the state and the gesture
   * without needing hover — the empty cell is the row's visual anomaly, so the
   * explanation sits where the eye already goes; the leading accent bar, which makes
   * the rows findable at a glance but explains nothing on its own; and the tooltip,
   * for the full sentence. Colour is never the only channel.
   */
  const renderUnsharedCells = (r: EnvironmentLocalViewRow): React.JSX.Element => (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex min-w-0 cursor-help items-center gap-1.5 px-2" tabIndex={0}>
            <span className="truncate text-xs font-medium">{r.name}</span>
            <span className="sr-only">{t('environment.local.unsharedTooltip')}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>{t('environment.local.unsharedTooltip')}</TooltipContent>
      </Tooltip>
      <input
        type="text"
        value={sharedDraft[r.name] ?? ''}
        onChange={(e) => setSharedDraft((prev) => ({ ...prev, [r.name]: e.target.value }))}
        onBlur={() => handleUnsharedSharedBlur(r.name).catch(console.error)}
        placeholder={t('environment.local.unsharedPlaceholder')}
        aria-label={t('environment.local.sharedColumn')}
        className="h-7 min-w-0 rounded border border-transparent bg-transparent px-2 text-xs placeholder:text-muted-foreground/50 focus:border-border focus:outline-none"
      />
      <SyncCheck checked={false} onToggle={() => handleUnsharedSync(r)} />
      <LocalValueCell
        name={r.name}
        isSecret={false}
        synced={false}
        hasOverride={r.hasLocalOverride}
        orphan={r.orphan}
        invalid={r.invalid}
        localDisplay={r.localDisplay}
        revealed={undefined}
        locked={locked}
        onCommit={(n, v) => handleSetLocal(n, v).catch(console.error)}
        onReveal={(n) => handleRevealLocal(n).catch(console.error)}
        onHideReveal={() => undefined}
      />
      <div className="flex items-center justify-end gap-1">
        <button
          onClick={() => handleMakeSecret(r.name, '', true).catch(console.error)}
          disabled={makeSecretBusy}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-primary disabled:opacity-30"
          aria-label={t('secrets.makeSecret')}
          title={t('secrets.makeSecret')}
        >
          <Lock className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => handleClearLocal(r.name).catch(console.error)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive"
          aria-label={t('keyValue.remove')}
          title={t('keyValue.remove')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </>
  )

  const envRowNodes: EnvRowNode[] = unifiedEntries.map((e) => ({
    id: e.id,
    node:
      e.kind === 'plain' ? (
        <EnvRowShell>{renderPlainCells(e.row)}</EnvRowShell>
      ) : (
        <EnvRowShell className="bg-primary/5">{renderSecretCells(e.name, e.value)}</EnvRowShell>
      )
  }))

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) handleClose()
        }}
      >
        <DialogContent
          className="h-[540px] max-w-[920px] gap-0 p-0"
          // radix-ui ≥1.6 reports a pointer-down that dismisses a stacked child
          // dialog (the secret-flow setup/confirm dialogs render as sibling
          // layers) as an "outside" interaction on this lower layer, which would
          // tear the editor down mid-flow. Ignore any outside interaction whose
          // target sits inside another dialog; a genuine click on the app behind
          // the modal (target not in a dialog) still closes it.
          onInteractOutside={(e) => {
            if ((e.target as Element | null)?.closest('[role="dialog"]')) e.preventDefault()
          }}
          // Escape inside an open inline rename/duplicate editor means "abandon
          // that name", not "close the environment editor". Radix dismisses from
          // a capture-phase document listener, so the input cannot contain the
          // key itself — this is the only place that can.
          onEscapeKeyDown={(e) => {
            if (inlineEditorOpen) e.preventDefault()
          }}
        >
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>{t('environment.manage')}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-1 overflow-hidden">
            {/* Left sidebar — environment list (rows + context menu + create) */}
            <EnvironmentList
              environments={environments}
              selectedId={selectedId}
              onSelect={handleSelectEnv}
              onCreate={handleCreate}
              onRename={handleRename}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
              onInlineEditorOpenChange={setInlineEditorOpen}
            />

            {/* Right — variables + secrets editor */}
            <div className="flex flex-1 flex-col overflow-hidden">
              {selectedEnv ? (
                <>
                  <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t('environment.variables')} — {selectedEnv.name}
                    </span>
                    <div className="flex items-center gap-2">
                      {divergedNames.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 text-xs"
                          onClick={() => setSyncAllConfirm(divergedNames)}
                          title={t('environment.local.syncAll.tooltip')}
                        >
                          <RotateCcw className="h-3 w-3" />
                          {t('environment.local.syncAll.button')}
                        </Button>
                      )}
                      {status?.hasManifest && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 text-xs"
                          onClick={() => setShowRotate(true)}
                          title={t('secrets.rotate.title')}
                        >
                          <RefreshCw className="h-3 w-3" />
                          {t('secrets.rotate.button')}
                        </Button>
                      )}
                    </div>
                  </div>

                  {locked && (
                    <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                      <Lock className="h-3.5 w-3.5 text-warning" />
                      <span className="flex-1">{t('secrets.locked.banner')}</span>
                      <Button
                        size="sm"
                        className="h-6 text-xs"
                        onClick={() => setShowEnterKey(true)}
                      >
                        {t('secrets.locked.unlock')}
                      </Button>
                    </div>
                  )}
                  {status?.backend === 'session-only' && (
                    <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-[11px] text-muted-foreground">
                      <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                      <span>{t('secrets.sessionOnlyNotice')}</span>
                    </div>
                  )}

                  <TooltipProvider>
                    <div className="flex-1 overflow-y-auto">
                      {/* Header row — leading spacer aligns with each row's drag handle. */}
                      <div className="flex items-center border-b border-border bg-surface-2">
                        <span className="w-5 shrink-0" aria-hidden />
                        <div className={cn(ROW_GRID, 'min-w-0 flex-1 px-3 py-1')}>
                          <span className="px-2 text-xs font-medium text-muted-foreground">
                            {t('environment.keyPlaceholder')}
                          </span>
                          <span className="px-2 text-xs font-medium text-muted-foreground">
                            {t('environment.local.sharedColumn')}
                          </span>
                          <span aria-hidden />
                          <span className="px-2 text-xs font-medium text-muted-foreground">
                            {t('environment.local.localColumn')}
                          </span>
                          <span aria-hidden />
                        </div>
                      </div>

                      {unifiedEntries.length === 0 && unsharedRows.length === 0 && (
                        <p className="px-3 py-4 text-xs text-muted-foreground">
                          {t('environment.noVariables')}
                        </p>
                      )}

                      {/* Variables present in config.json: drag-reorderable, in map order (REQ-0079). */}
                      {envRowNodes.length > 1 ? (
                        <Suspense fallback={<EnvStaticList rows={envRowNodes} />}>
                          <SortableRows rows={envRowNodes} onReorder={handleReorderVariables} />
                        </Suspense>
                      ) : (
                        <EnvStaticList rows={envRowNodes} />
                      )}

                      {/* REQ-0108 — unshared variables continue the same list: same shell, same
                        grid, same actions. They render outside the sortable container because
                        that is what gives every row it wraps a drag handle, and an unshared row
                        has no slot in config.json to persist an order into (§6.4). */}
                      {unsharedRows.map((r) => (
                        <EnvRowShell key={`unshared-${r.name}`} accent>
                          {renderUnsharedCells(r)}
                        </EnvRowShell>
                      ))}

                      <button
                        onClick={handleAddRow}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t('keyValue.addRow')}
                      </button>
                    </div>
                  </TooltipProvider>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-xs text-muted-foreground">{t('environment.noEnvironment')}</p>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Git-history note before encrypting an existing value (CA-17). */}
      {gitNote && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setGitNote(null)
          }}
        >
          <DialogContent className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" />
                {t('secrets.gitNote.title')}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t('secrets.gitNote.body')}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setGitNote(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => {
                  const note = gitNote
                  setGitNote(null)
                  finishMakeSecret(note.name, note.value).catch(console.error)
                }}
              >
                {t('secrets.gitNote.continue')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Plaintext-commit confirmation before making a secret plain (CA-11). */}
      {unsetConfirm && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setUnsetConfirm(null)
          }}
        >
          <DialogContent className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Unlock className="h-4 w-4 text-warning" />
                {t('secrets.unsetConfirm.title')}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {t('secrets.unsetConfirm.body', { name: unsetConfirm })}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUnsetConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => handleUnsetSecret(unsetConfirm).catch(console.error)}>
                {t('secrets.unsetConfirm.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* REQ-0077 — direct secret deletion. Copy calibrated to reversibility; the
          value is never shown. Mentions the local override when one exists. */}
      {deleteSecretConfirm && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteSecretConfirm(null)
          }}
        >
          <DialogContent className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-destructive" />
                {t('secrets.deleteConfirm.title')}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {deleteSecretConfirm.isNull
                ? t('secrets.deleteConfirm.needsValueBody', {
                    name: deleteSecretConfirm.name
                  })
                : t('secrets.deleteConfirm.encryptedBody', {
                    name: deleteSecretConfirm.name
                  })}
              {deleteSecretConfirm.hasLocal ? ` ${t('secrets.deleteConfirm.localNote')}` : ''}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteSecretConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleDeleteSecret(deleteSecretConfirm.name).catch(console.error)}
              >
                {t('secrets.deleteConfirm.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Re-check confirmation: returning a diverged value to the shared one (REQ-0075 §5.2). */}
      {recheckConfirm && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRecheckConfirm(null)
          }}
        >
          <DialogContent className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <RotateCcw className="h-4 w-4 text-warning" />
                {t('environment.local.recheck.title')}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {recheckConfirm.sharedIsNull
                ? t('environment.local.recheck.needsValue', {
                    name: recheckConfirm.name,
                    local: recheckConfirm.localDisplay
                  })
                : t('environment.local.recheck.body', {
                    shared: recheckConfirm.sharedDisplay,
                    local: recheckConfirm.localDisplay
                  })}
            </p>
            {/* REQ-0108 — the standard wording understates the consequence when the
                variable returns to nothing; name the remedy where the user is standing. */}
            {recheckConfirm.emptyDestination && (
              <p className="text-xs text-warning">
                {t('environment.local.recheck.emptyDestination')}
              </p>
            )}
            {recheckConfirm.scriptHint && (
              <p className="text-xs text-warning">{t('environment.local.recheck.scriptHint')}</p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setRecheckConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => handleConfirmRecheck().catch(console.error)}>
                {t('environment.local.recheck.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Bulk "Sync all": return every diverged variable to shared after one confirm (Q1). */}
      {syncAllConfirm && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSyncAllConfirm(null)
          }}
        >
          <DialogContent className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <RotateCcw className="h-4 w-4 text-warning" />
                {t('environment.local.syncAll.title')}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {t('environment.local.syncAll.body', {
                names: syncAllConfirm.join(', ')
              })}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSyncAllConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => handleSyncAll().catch(console.error)}>
                {t('environment.local.syncAll.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {setupResult && (
        <SecretSetupDialog
          workspaceKey={setupResult.key}
          keyId={setupResult.keyId}
          variant="setup"
          onAcknowledge={() => {
            setSetupResult(null)
            const p = pending
            if (p) handleMakeSecret(p.name, p.value, p.needsValue).catch(console.error)
          }}
        />
      )}

      {showEnterKey && (
        <EnterKeyDialog
          expectedKeyId={status?.keyId}
          onClose={() => {
            setShowEnterKey(false)
            setPending(null)
          }}
          onUnlocked={() => {
            setShowEnterKey(false)
            const p = pending
            if (p) handleMakeSecret(p.name, p.value, p.needsValue).catch(console.error)
          }}
        />
      )}

      {showRotate && (
        <RotateKeyDialog
          onClose={() => setShowRotate(false)}
          onRotated={() => {
            const wp = useEnvironmentStore.getState().workspacePath
            if (wp) useEnvironmentStore.getState().loadEnvironments(wp).catch(console.error)
            setRevealed({})
            setCorruptNames(new Set())
          }}
        />
      )}
    </>
  )
}

// ── Main exported component ─────────────────────────────────────────────────

export function EnvironmentManager(): React.JSX.Element {
  const { t } = useTranslation()
  const { environments, activeEnvironmentId, setActive } = useEnvironmentStore()
  const [modalOpen, setModalOpen] = useState(false)

  const activeEnv = environments.find((e) => e.id === activeEnvironmentId) ?? null
  // Alphabetical, not folder order: the store holds what the filesystem handed
  // back, which is an accident nobody chose. Same comparator the maintenance
  // panel's A → Z uses, so a name sits in the same place in both lists.
  const options = useMemo(
    () => buildEnvironmentListView(environments, { sort: 'asc' }),
    [environments]
  )

  return (
    <>
      <div className="flex items-center">
        <div className="relative flex items-center">
          <select
            value={activeEnvironmentId ?? ''}
            onChange={(e) => setActive(e.target.value || null)}
            className={cn(
              'h-7 appearance-none rounded-l-md rounded-r-none border border-border-default bg-background pl-2 pr-6 text-xs',
              'focus:outline-none focus:ring-1 focus:ring-ring',
              !activeEnv && 'text-muted-foreground'
            )}
            aria-label={t('environment.label')}
          >
            <option value="">{t('environment.noEnvironment')}</option>
            {options.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" />
        </div>

        <button
          onClick={() => setModalOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded-r-md border border-l-0 border-border-default bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t('environment.manage')}
          title={t('environment.manage')}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>

      {modalOpen && <EnvironmentEditorModal onClose={() => setModalOpen(false)} />}
    </>
  )
}
