import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import type { CookieSnapshot, CookieWarning, ExecutionWarning } from '../../../shared/types'

/**
 * REQ-0115 — the Cookies section of the response viewer.
 *
 * Shows both directions, not just what the response offered: when a cookie does
 * not turn up where the user expected, the useful question is usually "was it
 * even sent?", and the answer lived nowhere before this.
 *
 * Warnings sit above the tables because a rejected cookie is precisely the case
 * where the tables are empty and the user needs to know why.
 */

export interface CookiesTabProps {
  cookies?: { sent: CookieSnapshot[]; received: CookieSnapshot[] }
  warnings?: ExecutionWarning[]
}

/** The advisories this section owns. Other kinds ride the same channel and are not ours to render. */
export function cookieWarningsOf(warnings: ExecutionWarning[] | undefined): CookieWarning[] {
  return (warnings ?? []).filter(
    (w): w is CookieWarning =>
      w.code === 'COOKIE_REJECTED' || w.code === 'COOKIE_CROSS_SITE_INSECURE'
  )
}

/** Row count the tab badge shows: everything this section lists, in both directions. */
export function cookieRowCount(cookies: CookiesTabProps['cookies']): number {
  return (cookies?.sent.length ?? 0) + (cookies?.received.length ?? 0)
}

/**
 * Effective expiry, already resolved by the engine. A session cookie is labelled
 * rather than left blank, because blank reads as "unknown" and this is known.
 */
function expiryLabel(iso: string | null, t: (k: string) => string): string {
  if (!iso) return t('response.cookies.session')
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * A cookie that also covers subdomains is shown with the conventional leading
 * dot. The dot is display only — it is normalized away on the way in, and the
 * meaning lives in `hostOnly` (REQ-0115 §6.5).
 */
function domainLabel(c: CookieSnapshot): string {
  return c.hostOnly ? c.domain : `.${c.domain}`
}

/**
 * Column layout.
 *
 * `flex` columns hold values of arbitrary length: they share the available width
 * and truncate, with the full text on hover. `fixed` columns hold a short bounded
 * token (`true`/`false`, a cross-site value) and take only what their header
 * needs — giving them more is spending width on nothing, and it is what pushed
 * the trailing columns off the edge.
 */
type ColumnKey =
  'name' | 'value' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite' | 'hop'

interface ColumnSpec {
  key: ColumnKey
  kind: 'flex' | 'fixed'
  /** Fixed columns only: the width they always take, in pixels. */
  width?: number
  /** Flex columns only: their share of the width left over after the fixed ones. */
  weight?: number
}

const COLUMNS: ColumnSpec[] = [
  // `weight` is the share of the leftover width a flex column takes once the
  // fixed ones are paid for. Value earns the most because it is the field most
  // likely to be long and the one a reader squints at.
  { key: 'name', weight: 3, kind: 'flex' },
  { key: 'value', weight: 4, kind: 'flex' },
  { key: 'domain', weight: 2.2, kind: 'flex' },
  { key: 'path', weight: 1.6, kind: 'flex' },
  { key: 'expires', weight: 2.6, kind: 'flex' },
  // Sized to their own headers — the label bounds them, not the value, because
  // the value is only ever `true` or `false`.
  { key: 'httpOnly', width: 76, kind: 'fixed' },
  { key: 'secure', width: 64, kind: 'fixed' },
  { key: 'sameSite', width: 80, kind: 'fixed' },
  { key: 'hop', weight: 3, kind: 'flex' }
]

const MIN_COLUMN_WIDTH = 44
/** Fallback container width when the real one cannot be measured (jsdom, first paint). */
const ASSUMED_WIDTH = 900

/**
 * Lay the columns out for a given container width: fixed columns take what they
 * declared, and the flex ones share whatever is left, by weight. This is what
 * makes every column visible without a horizontal scrollbar — the user's actual
 * complaint was that the trailing ones fell off the edge.
 */
function layout(columns: ColumnSpec[], containerWidth: number): Record<string, number> {
  const fixedTotal = columns.reduce((sum, c) => sum + (c.kind === 'fixed' ? c.width! : 0), 0)
  const weightTotal = columns.reduce((sum, c) => sum + (c.kind === 'flex' ? c.weight! : 0), 0)
  const spare = Math.max(0, containerWidth - fixedTotal)
  const out: Record<string, number> = {}
  // The last flex column absorbs the rounding remainder so the columns sum to
  // *exactly* the container. Letting a few pixels evaporate here leaves the table
  // narrower than its panel, and the correction on first drag then shifts every
  // column — which reads as the drag doing something it was not asked to do.
  const lastFlex = [...columns].reverse().find((c) => c.kind === 'flex')
  let used = 0
  for (const c of columns) {
    if (c.kind === 'fixed') {
      out[c.key] = c.width!
      used += c.width!
      continue
    }
    if (c === lastFlex) continue
    const w = Math.max(MIN_COLUMN_WIDTH, Math.floor((spare * c.weight!) / weightTotal))
    out[c.key] = w
    used += w
  }
  if (lastFlex) out[lastFlex.key] = Math.max(MIN_COLUMN_WIDTH, containerWidth - used)
  return out
}

/**
 * Move the border between two adjacent columns: the left one takes exactly what
 * the right one gives up.
 *
 * The total is therefore invariant, which is the point — the table keeps filling
 * its container and never grows a horizontal scrollbar. The delta is clamped so
 * neither side can be pushed under the minimum, so dragging past that limit
 * simply stops instead of squeezing a column to nothing.
 */
function resizePair(
  widths: Record<string, number>,
  leftKey: string,
  rightKey: string,
  delta: number
): Record<string, number> {
  const left = widths[leftKey] ?? 0
  const right = widths[rightKey] ?? 0
  const clamped = Math.max(-(left - MIN_COLUMN_WIDTH), Math.min(right - MIN_COLUMN_WIDTH, delta))
  if (clamped === 0) return widths
  return { ...widths, [leftKey]: left + clamped, [rightKey]: right - clamped }
}

/**
 * Rescale a manual layout to a new container width, preserving the proportions
 * the user chose. The last column absorbs the rounding remainder so the columns
 * still sum to exactly the container — dropping a pixel here would let a
 * scrollbar appear after a few resizes.
 */
function rescale(
  widths: Record<string, number>,
  columns: ColumnSpec[],
  containerWidth: number
): Record<string, number> {
  const total = columns.reduce((sum, c) => sum + (widths[c.key] ?? 0), 0)
  if (total <= 0 || total === containerWidth) return widths
  const factor = containerWidth / total
  const out: Record<string, number> = {}
  let used = 0
  columns.forEach((c, i) => {
    if (i === columns.length - 1) {
      out[c.key] = Math.max(MIN_COLUMN_WIDTH, containerWidth - used)
      return
    }
    const w = Math.max(MIN_COLUMN_WIDTH, Math.floor((widths[c.key] ?? 0) * factor))
    out[c.key] = w
    used += w
  })
  return out
}

function cellFor(c: CookieSnapshot, key: ColumnKey, t: (k: string) => string): string {
  switch (key) {
    case 'name':
      return c.name
    case 'value':
      return c.value
    case 'domain':
      return domainLabel(c)
    case 'path':
      return c.path
    case 'expires':
      return expiryLabel(c.expires, t)
    case 'httpOnly':
      return String(c.httpOnly)
    case 'secure':
      return String(c.secure)
    case 'sameSite':
      return c.sameSite ?? '—'
    case 'hop':
      return c.url
  }
}

/**
 * Drag handle on a column border.
 *
 * Reports the **incremental** movement since the last event and lets the caller
 * add it to whatever the width currently is. An earlier version passed a `base`
 * captured at pointer-down and computed `base + delta`; because `delta` was also
 * incremental, every move recomputed roughly the original width and the column
 * visibly never moved.
 *
 * Listener discipline follows the activity panel's resizer (REQ-0104): they live
 * on `window` and are released on `pointerup` **and** `pointercancel`, so a drag
 * the OS revokes cannot leave a live `pointermove` resizing forever.
 */
function ResizeHandle({
  onResize,
  onStart,
  label
}: {
  onResize: (deltaPx: number) => void
  onStart: () => void
  label: string
}): React.JSX.Element {
  const last = useRef<number | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      onStart()
      last.current = e.clientX

      const onMove = (move: PointerEvent): void => {
        if (last.current === null) return
        onResize(move.clientX - last.current)
        last.current = move.clientX
      }
      const release = (): void => {
        last.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointercancel', release)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', release, { once: true })
      window.addEventListener('pointercancel', release, { once: true })
    },
    [onResize, onStart]
  )

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      // Straddles the border with a grab area wider than the line itself, and
      // shows a permanent divider: a handle the user has to guess the location
      // of is a handle that does not exist.
      className="group/resize absolute -right-[3px] top-0 z-10 flex h-full w-[7px] cursor-col-resize touch-none select-none items-center justify-center"
    >
      <span className="h-3 w-px bg-border transition-colors group-hover/resize:h-full group-hover/resize:w-[2px] group-hover/resize:bg-primary" />
    </span>
  )
}

function CookieTable({
  title,
  rows,
  emptyKey,
  columns,
  widths,
  onResizeStart,
  onResize
}: {
  title: string
  rows: CookieSnapshot[]
  emptyKey: string
  columns: ColumnSpec[]
  widths: Record<string, number>
  onResizeStart: () => void
  onResize: (leftKey: ColumnKey, rightKey: ColumnKey, deltaPx: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const total = columns.reduce((sum, c) => sum + (widths[c.key] ?? 0), 0)

  return (
    <section className="mb-4">
      <h3 className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {title} <span className="tabular-nums opacity-70">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">{t(emptyKey)}</p>
      ) : (
        // `table-fixed` plus an explicit total width is what makes the declared
        // widths authoritative. With a percentage width the browser rescales them
        // and a drag gets absorbed into the redistribution instead of moving the
        // border. Overflow scrolls only once the user has widened past the panel.
        <div className="overflow-x-auto">
          <table className="table-fixed text-xs" style={{ width: total }}>
            <colgroup>
              {columns.map((col) => (
                <col key={col.key} style={{ width: widths[col.key] }} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {columns.map((col, i) => (
                  <th
                    key={col.key}
                    className="relative px-3 py-1.5 text-left font-medium text-muted-foreground"
                  >
                    <span className="block truncate">{t(`response.cookies.${col.key}`)}</span>
                    {/* Borders BETWEEN columns only. The trailing edge has no
                        neighbour to trade width with, so a handle there could
                        only push the table past its container. */}
                    {i < columns.length - 1 && (
                      <ResizeHandle
                        label={t('response.cookies.resizeColumn')}
                        onStart={onResizeStart}
                        onResize={(delta) => onResize(col.key, columns[i + 1].key, delta)}
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <tr
                  key={`${c.url}-${c.domain}-${c.path}-${c.name}-${i}`}
                  className="border-b border-border/50 hover:bg-surface-2"
                >
                  {columns.map((col) => {
                    const text = cellFor(c, col.key, t)
                    return (
                      <td
                        key={col.key}
                        // The full value on hover: truncation must never be the
                        // only copy of what the server actually sent.
                        title={
                          c.stored === false && col.key === 'name'
                            ? `${text} — ${t('response.cookies.notStored')}`
                            : text
                        }
                        className={cn(
                          'truncate px-3 py-1',
                          col.key === 'expires' ? '' : 'font-mono',
                          col.key === 'name' ? 'text-primary/80' : 'text-foreground',
                          col.kind === 'fixed' && 'text-muted-foreground',
                          // A cookie the server sent and the jar refused is
                          // listed, not hidden — dimmed so it reads as "not
                          // kept" at a glance, with the reason in the warnings.
                          c.stored === false && 'opacity-60',
                          c.stored === false && col.key === 'name' && 'line-through'
                        )}
                      >
                        {text}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function WarningList({ warnings }: { warnings: CookieWarning[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ul className="mb-3 border-b border-border">
      {warnings.map((w, i) => (
        <li key={i} className="flex gap-2 px-3 py-1.5 text-xs">
          <span aria-hidden className="text-warning">
            ●
          </span>
          <span className="text-foreground">
            {w.code === 'COOKIE_REJECTED'
              ? t('response.cookies.rejected', {
                  name: w.name,
                  host: w.host,
                  reason: t(`response.cookies.reason.${w.reason}`)
                })
              : t('response.cookies.crossSiteInsecure', { name: w.name, host: w.host })}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function CookiesTab({ cookies, warnings }: CookiesTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const cookieWarnings = cookieWarningsOf(warnings)
  const isEmpty = cookieRowCount(cookies) === 0 && cookieWarnings.length === 0

  // The hop column earns its place only when the send actually touched more than
  // one URL — which is exactly the redirect case this feature exists for.
  const hops = new Set([...(cookies?.sent ?? []), ...(cookies?.received ?? [])].map((c) => c.url))
  const columns = hops.size > 1 ? COLUMNS : COLUMNS.filter((c) => c.key !== 'hop')

  // Widths live here rather than in each table so the two stay aligned — two
  // tables of the same columns drifting apart reads as a rendering bug.
  //
  // Two modes. Until the user drags, widths are recomputed from the container so
  // everything fits with no horizontal scrollbar. The first drag freezes them:
  // from then on the numbers are the user's and re-fitting would silently undo
  // the adjustment they just made.
  // State, not a ref: the measured container exists only in the populated
  // branch, and a mounted tab can switch from empty to populated through props
  // alone (another workspace tab), so the effect must re-run when it appears.
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [available, setAvailable] = useState(ASSUMED_WIDTH)
  const [manual, setManual] = useState<Record<string, number> | null>(null)

  useEffect(() => {
    const el = host
    if (!el) return
    const measure = (): void => setAvailable(el.clientWidth || ASSUMED_WIDTH)
    measure()
    // Guarded: jsdom has no ResizeObserver, and the fallback width keeps the
    // component renderable there.
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [host])

  // A manual layout is kept proportional to the container, so widening the panel
  // grows the columns the user sized rather than leaving a gap on the right.
  const widths = manual ? rescale(manual, columns, available) : layout(columns, available)

  // Plain functions: the React Compiler memoizes them, and a manual dependency
  // list here is exactly the kind of stale-closure trap that made the first
  // version of this resizer inert.
  const onResizeStart = (): void => {
    // Freeze the fitted widths as the starting point, so the first drag moves
    // from what is on screen rather than jumping to some default.
    setManual((prev) => prev ?? layout(columns, host?.clientWidth || ASSUMED_WIDTH))
  }

  const onResize = (leftKey: ColumnKey, rightKey: ColumnKey, delta: number): void => {
    // Incremental, and applied to the CURRENT widths: the left column takes
    // exactly what the right one gives up, so the total stays pinned to the
    // container and the table never grows a scrollbar.
    setManual((prev) => (prev ? resizePair(prev, leftKey, rightKey, delta) : prev))
  }

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t('response.cookies.empty')}
      </div>
    )
  }

  return (
    <div ref={setHost} className="h-full overflow-auto py-2">
      {cookieWarnings.length > 0 && <WarningList warnings={cookieWarnings} />}
      <CookieTable
        title={t('response.cookies.sent')}
        rows={cookies?.sent ?? []}
        emptyKey="response.cookies.noneSent"
        columns={columns}
        widths={widths}
        onResizeStart={onResizeStart}
        onResize={onResize}
      />
      <CookieTable
        title={t('response.cookies.received')}
        rows={cookies?.received ?? []}
        emptyKey="response.cookies.noneReceived"
        columns={columns}
        widths={widths}
        onResizeStart={onResizeStart}
        onResize={onResize}
      />
    </div>
  )
}
