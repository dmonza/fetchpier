import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Lock, Plus } from 'lucide-react'
import { cn } from '../../lib/utils'
import { applyOrder } from '../ui/sortable-context'
import { VariableHighlightInput } from '../ui/VariableHighlightInput'
import { KvTable } from './KvTable'
import { KvRow } from './KvRow'
import type { KeyValuePair } from '../../../shared/types'

/** A read-only entry materialized by the active auth scheme (REQ-0083 §6.3). */
export interface ManagedEntry {
  key: string
  value: string
}

// Common HTTP request headers for autocomplete
const COMMON_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Length',
  'Content-Type',
  'Cookie',
  'If-Modified-Since',
  'If-None-Match',
  'Origin',
  'Pragma',
  'Referer',
  'User-Agent',
  'X-API-Key',
  'X-Forwarded-For',
  'X-Request-ID'
]

interface KeyValueEditorProps {
  pairs: KeyValuePair[]
  onChange: (pairs: KeyValuePair[]) => void
  /** If true, shows a datalist with common HTTP headers for the key field */
  showHeaderAutocomplete?: boolean
  keyPlaceholder?: string
  valuePlaceholder?: string
  /** If true, all controls are disabled and add/remove actions are hidden */
  readOnly?: boolean
  /** Active environment variables — enables {{variable}} highlighting and autocomplete */
  variables?: Record<string, string | null>
  /**
   * Read-only entries projected from the active auth scheme (REQ-0083). Pinned
   * above the editable rows, non-draggable, non-deletable — editable only from
   * the Auth surface. Empty / omitted renders nothing.
   */
  managedEntries?: ManagedEntry[]
  /** Localized affordance shown on the managed rows pointing to the Auth surface. */
  managedHint?: string
  /**
   * Read-only rows for headers the engine adds by default at send time (e.g.
   * User-Agent, Accept-Encoding). Shown below the managed rows; never saved.
   */
  defaultEntries?: ManagedEntry[]
  /** Localized explanation shown on the default rows. */
  defaultHint?: string
}

let pairIdCounter = 1000

function newPair(): KeyValuePair {
  return { id: `kv-${pairIdCounter++}`, key: '', value: '', enabled: true }
}

export function KeyValueEditor({
  pairs,
  onChange,
  showHeaderAutocomplete = false,
  keyPlaceholder,
  valuePlaceholder,
  readOnly = false,
  variables = {},
  managedEntries = [],
  managedHint,
  defaultEntries = [],
  defaultHint
}: KeyValueEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const datalistId = showHeaderAutocomplete ? 'common-headers-list' : undefined
  const hint = managedHint ?? t('request.auth.managedByAuth')
  const implicitHint = defaultHint ?? t('request.headers.implicitDefault')

  // Read-only rows projected from the active auth scheme (REQ-0083 §6.3), then
  // the engine's implicit default headers. Pinned above the editable rows via the
  // table's `prefix` slot so they sit outside the sortable area and never reorder.
  const readOnlyRows = [
    ...managedEntries.map((m) => ({ entry: m, rowHint: hint, Icon: Lock, kind: 'auth' })),
    ...defaultEntries.map((m) => ({ entry: m, rowHint: implicitHint, Icon: Info, kind: 'default' }))
  ]
  const managedRows = readOnlyRows.map(({ entry: m, rowHint, Icon, kind }, idx) => (
    <KvRow
      key={`${kind}-managed-${idx}`}
      enabled
      readOnly
      toggleEnabledLabel={rowHint}
      leading={
        <span className="flex h-6 w-5 shrink-0 items-center justify-center" title={rowHint}>
          <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-label={rowHint} />
        </span>
      }
    >
      <VariableHighlightInput
        value={m.key}
        readOnly
        title={rowHint}
        variables={variables}
        className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent"
        inputClassName="px-2 text-xs text-muted-foreground cursor-default focus:outline-none"
      />
      <VariableHighlightInput
        value={m.value}
        readOnly
        title={rowHint}
        variables={variables}
        className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent"
        inputClassName="px-2 text-xs text-muted-foreground cursor-default focus:outline-none"
      />
      {/* Spacer matching the editable rows' delete button (h-6 w-6) so the
          key/value column boundary stays aligned across managed and manual rows. */}
      {!readOnly && <span aria-hidden className="h-6 w-6 shrink-0" />}
    </KvRow>
  ))

  const updatePair = (id: string, field: 'key' | 'value', value: string): void => {
    // REQ-0086: hand-editing a malformed query param expresses the intended
    // value, so clear the flag — the edited param is then encoded and persisted
    // normally on save instead of being dropped.
    //
    // REQ-0124: the value-less mark clears only on a **value** edit, and stays
    // clear even if the cell is emptied again — the value cell is the surface
    // that asserts a value exists, so touching it is that assertion. A key edit
    // deliberately preserves the mark: renaming a flag parameter must not add an
    // `=`. Hence the asymmetry with `malformed`, which clears on either edit.
    onChange(
      pairs.map((p) =>
        p.id === id
          ? {
              ...p,
              [field]: value,
              malformed: false,
              ...(field === 'value' && { valueless: false })
            }
          : p
      )
    )
  }

  const togglePair = (id: string): void => {
    onChange(pairs.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)))
  }

  const removePair = (id: string): void => {
    onChange(pairs.filter((p) => p.id !== id))
  }

  const addPair = (): void => {
    onChange([...pairs, newPair()])
  }

  return (
    <KvTable
      readOnly={readOnly}
      onReorder={readOnly ? undefined : (ids) => onChange(applyOrder(pairs, ids, (p) => p.id))}
      prefix={
        <>
          {datalistId && (
            <datalist id={datalistId}>
              {COMMON_HEADERS.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          )}
          {managedRows.map((row, idx) => (
            <Fragment key={`auth-managed-wrap-${idx}`}>{row}</Fragment>
          ))}
        </>
      }
      footer={
        !readOnly && (
          <button
            onClick={addPair}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('keyValue.addRow')}
          </button>
        )
      }
      rows={pairs.map((pair) => ({
        id: pair.id,
        node: (
          <KvRow
            enabled={pair.enabled}
            onToggleEnabled={() => togglePair(pair.id)}
            onRemove={() => removePair(pair.id)}
            readOnly={readOnly}
          >
            <VariableHighlightInput
              value={pair.key}
              onChange={(e) => !readOnly && updatePair(pair.id, 'key', e.target.value)}
              readOnly={readOnly}
              placeholder={keyPlaceholder ?? t('keyValue.keyPlaceholder')}
              list={readOnly ? undefined : datalistId}
              variables={variables}
              className={cn(
                'h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent',
                'focus-within:border-border'
              )}
              inputClassName={cn(
                'px-2 text-xs placeholder:text-muted-foreground focus:outline-none',
                readOnly && 'cursor-default'
              )}
            />
            <VariableHighlightInput
              value={pair.value}
              onChange={(e) => !readOnly && updatePair(pair.id, 'value', e.target.value)}
              readOnly={readOnly}
              placeholder={valuePlaceholder ?? t('keyValue.valuePlaceholder')}
              variables={variables}
              className={cn(
                'h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent',
                'focus-within:border-border'
              )}
              inputClassName={cn(
                'px-2 text-xs placeholder:text-muted-foreground focus:outline-none',
                readOnly && 'cursor-default'
              )}
            />
          </KvRow>
        )
      }))}
    />
  )
}
