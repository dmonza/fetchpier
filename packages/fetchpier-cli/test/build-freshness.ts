/**
 * Is a built artefact still a faithful image of the sources it came from?
 *
 * Pulled out of `global-setup.ts` so the decision can be tested without a
 * filesystem — the collaborator is injected. The caller keeps only the part
 * that cannot be: reading real mtimes and shelling out to the build.
 */

export interface FreshnessInputs {
  /** Build outputs to judge. */
  artefacts: readonly string[]
  /** Everything the build reads. An artefact older than any of these is stale. */
  sources: readonly string[]
  /** Modification time in ms, or `undefined` when the path does not exist. */
  mtimeOf: (path: string) => number | undefined
}

/**
 * The artefacts that must be rebuilt: those that do not exist, and those older
 * than the newest source.
 *
 * Two deliberate edges, both pinned by tests:
 *
 * - **A tie is fresh.** Comparison is strictly `artefact < newest source`.
 *   Filesystem timestamp granularity makes exact ties ordinary, and treating one
 *   as stale would rebuild on every single invocation.
 * - **No sources means stale.** An empty source list can only come from a caller
 *   whose paths are wrong. Reporting "fresh" there would disable the guard
 *   permanently and silently, which is worse than an unnecessary rebuild.
 */
export function staleArtefacts({ artefacts, sources, mtimeOf }: FreshnessInputs): string[] {
  const sourceTimes = sources
    .map(mtimeOf)
    .filter((time): time is number => typeof time === 'number')

  if (sourceTimes.length === 0) return [...artefacts]

  const newestSource = Math.max(...sourceTimes)

  return artefacts.filter((artefact) => {
    const built = mtimeOf(artefact)
    return built === undefined || built < newestSource
  })
}
