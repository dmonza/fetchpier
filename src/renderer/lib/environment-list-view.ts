import type { Environment } from '../../shared/types'

/**
 * The pure model behind the environment-management panel's list: which rows are
 * visible and in what order.
 *
 * Kept out of the component for the same reason `environment-variables.ts` is —
 * ordering and matching are data transforms, provable without a DOM. The panel
 * owns the query and the mode as session state and renders whatever this returns.
 *
 * Nothing here is persisted. The order is a **view** over the list core returned;
 * the environments on disk are not reordered, and neither the environment
 * dropdown nor a command-line run sees any of this.
 */

/**
 * How the list is ordered — by display name, ascending or descending.
 *
 * There is deliberately no "as it came from disk" mode: folder order is an
 * accident of the filesystem, not a choice anyone made, so offering it as a
 * third state cost a button and told the user nothing.
 */
export type EnvironmentSortMode = 'asc' | 'desc'

export interface EnvironmentListViewOptions {
  /** Free-text filter over the display name. Empty or blank filters nothing. */
  query?: string
  /** Defaults to `asc`. */
  sort?: EnvironmentSortMode
  /**
   * An environment that stays visible even when it does not match the query —
   * the row holding an open inline rename/duplicate field. That field carries text
   * the user typed, and the error explaining a rejected name; filtering it away
   * because the *stored* name no longer matches would discard both.
   */
  keepId?: string | null
}

/**
 * Case- and diacritic-insensitive comparison form. `Producción` and `produccion`
 * are the same string to a person searching, so they are the same string here.
 *
 * Deliberately *not* `deriveEnvFolderName`: that also slugs, which would make a
 * space match a hyphen and let `devqa` find `dev QA` — a filter has to behave the
 * way the user typed it.
 */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Filter, then order, the environments the panel shows.
 *
 * Never mutates the input array. `asc` uses `localeCompare` — the comparator the
 * request tree already sorts with, so two lists in the same product cannot
 * disagree about where an accented name belongs — and `desc` is its exact reverse.
 */
export function buildEnvironmentListView(
  environments: Environment[],
  { query = '', sort = 'asc', keepId = null }: EnvironmentListViewOptions
): Environment[] {
  const needle = fold(query.trim())
  const visible = needle
    ? environments.filter((env) => env.id === keepId || fold(env.name).includes(needle))
    : [...environments]

  const ordered = visible.sort((a, b) => a.name.localeCompare(b.name))
  return sort === 'asc' ? ordered : ordered.reverse()
}
