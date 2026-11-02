/**
 * The staleness decision the `cli` project's `globalSetup` acts on.
 *
 * Same split as the e2e host preconditions: the decision is pure
 * and exhaustively covered here, while the caller that shells out to `npm run
 * build` gets no case of its own. It matters for the same reason — the
 * consequence of getting it wrong is a suite that reports on a bundle nobody is
 * editing, which is invisible in the passing direction.
 *
 * Every collaborator is injected: these cases never touch a real clock or a real
 * filesystem, so the boundaries below are exact rather than timing-dependent.
 */
import { describe, expect, it } from 'vitest'
import { staleArtefacts } from './build-freshness'

/** `mtimes` is the injected filesystem: a path that is absent has no entry. */
function check(mtimes: Record<string, number>, artefacts: string[], sources: string[]): string[] {
  return staleArtefacts({
    artefacts,
    sources,
    mtimeOf: (path) => mtimes[path]
  })
}

describe('staleArtefacts', () => {
  it('reports an artefact that does not exist', () => {
    const stale = check({ 'src/a.ts': 10 }, ['dist/fp.js'], ['src/a.ts'])

    expect(stale).toEqual(['dist/fp.js'])
  })

  it('reports nothing when every artefact is newer than every source', () => {
    const stale = check(
      { 'dist/fp.js': 20, 'dist/index.js': 21, 'src/a.ts': 10 },
      ['dist/fp.js', 'dist/index.js'],
      ['src/a.ts']
    )

    expect(stale).toEqual([])
  })

  it('reports an artefact older than a source', () => {
    const stale = check({ 'dist/fp.js': 5, 'src/a.ts': 10 }, ['dist/fp.js'], ['src/a.ts'])

    expect(stale).toEqual(['dist/fp.js'])
  })

  // The boundary. Timestamp granularity makes exact ties ordinary — a build that
  // writes within the same tick as the edit that triggered it is not evidence of
  // staleness, and treating it as such would rebuild on every invocation.
  it('treats an artefact and its newest source sharing a timestamp as fresh', () => {
    const stale = check({ 'dist/fp.js': 10, 'src/a.ts': 10 }, ['dist/fp.js'], ['src/a.ts'])

    expect(stale).toEqual([])
  })

  it('reports an artefact one tick behind its newest source', () => {
    const stale = check({ 'dist/fp.js': 9, 'src/a.ts': 10 }, ['dist/fp.js'], ['src/a.ts'])

    expect(stale).toEqual(['dist/fp.js'])
  })

  it('compares against the newest source, not the first one', () => {
    const stale = check(
      { 'dist/fp.js': 15, 'src/old.ts': 1, 'src/new.ts': 20 },
      ['dist/fp.js'],
      ['src/old.ts', 'src/new.ts']
    )

    expect(stale).toEqual(['dist/fp.js'])
  })

  it('reports only the artefacts that are actually behind', () => {
    const stale = check(
      { 'dist/fp.js': 5, 'dist/index.js': 20, 'src/a.ts': 10 },
      ['dist/fp.js', 'dist/index.js'],
      ['src/a.ts']
    )

    expect(stale).toEqual(['dist/fp.js'])
  })

  // A glob that matched nothing means the caller's source list is wrong. Calling
  // that "fresh" would disable the guard silently and for good, which is the one
  // outcome worse than rebuilding too often.
  it('treats every artefact as stale when no source was found', () => {
    const stale = check({ 'dist/fp.js': 20 }, ['dist/fp.js'], [])

    expect(stale).toEqual(['dist/fp.js'])
  })

  it('ignores a source that has since disappeared', () => {
    const stale = check(
      { 'dist/fp.js': 20, 'src/a.ts': 10 },
      ['dist/fp.js'],
      ['src/a.ts', 'src/deleted.ts']
    )

    expect(stale).toEqual([])
  })
})
