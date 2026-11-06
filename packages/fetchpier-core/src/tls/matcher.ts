import type { ClientCertEntry, TlsScope } from '@shared/types'

/**
 * Where a candidate certificate comes from. `run` is material given for one
 * command-line run (`--tls-config`); it never reaches the desktop, which is why
 * it is not part of the shared {@link TlsScope}.
 */
export type CandidateScope = TlsScope | 'run'

/** Tie-break between scopes on the same specificity tier: lower wins. */
const SCOPE_RANK: Record<CandidateScope, number> = { run: 0, workspace: 1, app: 2 }

export interface ClientCertCandidate {
  entry: ClientCertEntry
  scope: CandidateScope
  /** Stable position in the originating scope's list — breaks ties at the lowest level. */
  index: number
}

export interface ClientCertMatch {
  selected: ClientCertEntry
  scope: CandidateScope
}

/**
 * Specificity tier for a candidate:
 *   3 = literal host + explicit port
 *   2 = literal host, any port
 *   1 = wildcard host + explicit port
 *   0 = wildcard host, any port
 */
function specificityTier(entry: ClientCertEntry): number {
  const isWildcard = entry.host.startsWith('*.')
  const hasPort = entry.port != null
  if (!isWildcard && hasPort) return 3
  if (!isWildcard && !hasPort) return 2
  if (isWildcard && hasPort) return 1
  return 0
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port)
  if (url.protocol === 'https:') return 443
  if (url.protocol === 'http:') return 80
  return 0
}

function hostMatches(pattern: string, host: string): boolean {
  const lowerPattern = pattern.toLowerCase()
  const lowerHost = host.toLowerCase()
  if (lowerPattern === lowerHost) return true
  if (lowerPattern.startsWith('*.')) {
    const suffix = lowerPattern.slice(2)
    if (!lowerHost.endsWith('.' + suffix)) return false
    const prefix = lowerHost.slice(0, lowerHost.length - suffix.length - 1)
    // Single-label wildcard (Postman semantics): the prefix may not contain a dot.
    return prefix.length > 0 && !prefix.includes('.')
  }
  return false
}

function portMatches(entry: ClientCertEntry, requestPort: number): boolean {
  if (entry.port == null) return true
  return entry.port === requestPort
}

/**
 * Find the single best client certificate for an outgoing request URL among
 * the candidates supplied. Disabled candidates are skipped. See REQ-0053 §5.
 *
 * @returns the winning candidate or `null` if nothing matched.
 */
export function matchClientCertificate(
  url: URL,
  candidates: ClientCertCandidate[],
  /** Receives the same-tier ambiguity notice (the matcher never writes to the console). */
  onWarning?: (reason: string) => void
): ClientCertMatch | null {
  const host = url.hostname
  const port = effectivePort(url)

  const matching = candidates.filter(
    (c) => !c.entry.disabled && hostMatches(c.entry.host, host) && portMatches(c.entry, port)
  )

  if (matching.length === 0) return null

  matching.sort((a, b) => {
    const tierDiff = specificityTier(b.entry) - specificityTier(a.entry)
    if (tierDiff !== 0) return tierDiff
    // At the same tier: a run certificate (named explicitly for this run) beats
    // the workspace's, which beats app-global.
    if (a.scope !== b.scope) return SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]
    return a.index - b.index
  })

  const winner = matching[0]
  // Surface ambiguity (same tier, same scope) so the user can clean up duplicate metadata.
  if (matching.length > 1) {
    const next = matching[1]
    if (
      specificityTier(winner.entry) === specificityTier(next.entry) &&
      winner.scope === next.scope
    ) {
      onWarning?.(
        `several client certificates match ${host}:${port} equally in the ${winner.scope} scope; using "${winner.entry.host}" (first in document order)`
      )
    }
  }

  return { selected: winner.entry, scope: winner.scope }
}
