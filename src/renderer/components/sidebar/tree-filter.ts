/**
 * Pure filtering helpers for the collection tree sidebar search. Kept free of
 * React/DOM (like `tree-nav.ts` and `tree-dnd.ts`) so filtering rules are
 * directly unit-testable.
 *
 * Matching is by name only (URL and method belong to the command palette), a
 * case-insensitive substring per word, and a multi-word query must match every
 * word — never fuzzy.
 */

import type { WorkspaceTree } from '../../../shared/types'
import { instanceDisplayName } from '../../../shared/lib/request-instances'

/** The lowercased, whitespace-separated words of `query`; empty for a blank query. */
function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** The label a row shows: a folder's name, a request's stem, an instance's display name. */
export function searchableLabel(node: WorkspaceTree, parentStem: string | null): string {
  if (node.type === 'folder') return node.name
  if (node.kind === 'instance') {
    return instanceDisplayName(node.name, new Set(parentStem ? [parentStem] : []))
  }
  return node.name.replace(/\.http$/, '')
}

function matchesAll(label: string, terms: string[]): boolean {
  const lower = label.toLowerCase()
  return terms.every((term) => lower.includes(term))
}

/**
 * Filter a collection tree by each node's display label.
 *
 * - An empty/whitespace query returns `nodes` unchanged.
 * - A label matches when it contains every word of the query, ignoring case.
 * - A folder or parent request whose own label matches keeps all of its
 *   children so the user can still browse inside a matched collection.
 * - Otherwise, a parent is kept only if at least one descendant matches,
 *   pruned to the matching branches.
 */
export function filterTree(
  nodes: WorkspaceTree[],
  query: string,
  parentStem: string | null = null
): WorkspaceTree[] {
  const terms = termsOf(query)
  if (terms.length === 0) return nodes
  return filterByTerms(nodes, terms, parentStem)
}

function filterByTerms(
  nodes: WorkspaceTree[],
  terms: string[],
  parentStem: string | null
): WorkspaceTree[] {
  const result: WorkspaceTree[] = []
  for (const node of nodes) {
    if (matchesAll(searchableLabel(node, parentStem), terms)) {
      result.push(node)
      continue
    }
    if (node.children && node.children.length > 0) {
      const nextParentStem = node.kind === 'request' ? node.name.replace(/\.http$/, '') : null
      const filteredChildren = filterByTerms(node.children, terms, nextParentStem)
      if (filteredChildren.length > 0) {
        result.push({ ...node, children: filteredChildren })
      }
    }
  }
  return result
}

/**
 * The `[start, end)` character ranges of `label` to highlight for `query`: every
 * occurrence of every word, ignoring case, sorted, with overlapping ranges merged.
 * Empty when the query is blank or the label does not contain every word (a row
 * kept only because its folder matched shows no highlight).
 */
export function matchRanges(label: string, query: string): Array<[number, number]> {
  const terms = termsOf(query)
  if (terms.length === 0 || !matchesAll(label, terms)) return []
  const lower = label.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
      ranges.push([at, at + term.length])
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = []
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1]
    if (last && start < last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}
