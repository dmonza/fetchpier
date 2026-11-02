import { describe, it, expect } from 'vitest'
import { buildEnvironmentListView, type EnvironmentSortMode } from './environment-list-view'
import type { Environment } from '../../shared/types'

function env(name: string, id = name.toLowerCase()): Environment {
  return { id, folder: id, name, variables: {} }
}

/** Deliberately not in alphabetical order — the sort must be observable. */
const ENVS: Environment[] = [
  env('Staging', 'id-staging'),
  env('Producción', 'id-prod'),
  env('dev QA', 'id-dev'),
  env('Ada', 'id-ada')
]

const names = (list: Environment[]): string[] => list.map((e) => e.name)

describe('buildEnvironmentListView — sorting', () => {
  it('defaults to ascending when no mode is given', () => {
    expect(names(buildEnvironmentListView(ENVS, {}))).toEqual([
      'Ada',
      'dev QA',
      'Producción',
      'Staging'
    ])
  })

  it('orders by display name, so case and accents sit where a reader expects', () => {
    expect(names(buildEnvironmentListView(ENVS, { sort: 'asc' }))).toEqual([
      'Ada',
      'dev QA',
      'Producción',
      'Staging'
    ])
  })

  it('makes desc the exact reverse of asc', () => {
    const asc = names(buildEnvironmentListView(ENVS, { sort: 'asc' }))
    expect(names(buildEnvironmentListView(ENVS, { sort: 'desc' }))).toEqual([...asc].reverse())
  })

  it('never mutates the array it was given', () => {
    const input = [...ENVS]
    buildEnvironmentListView(input, { sort: 'asc' })
    expect(names(input)).toEqual(names(ENVS))
  })

  it('returns an empty list for an empty input in both modes', () => {
    const modes: EnvironmentSortMode[] = ['asc', 'desc']
    for (const sort of modes) expect(buildEnvironmentListView([], { sort })).toEqual([])
  })
})

describe('buildEnvironmentListView — filtering', () => {
  it('matches a substring anywhere in the display name', () => {
    expect(names(buildEnvironmentListView(ENVS, { query: 'ag' }))).toEqual(['Staging'])
  })

  it('ignores case', () => {
    expect(names(buildEnvironmentListView(ENVS, { query: 'STAG' }))).toEqual(['Staging'])
  })

  it('ignores accents in both directions', () => {
    expect(names(buildEnvironmentListView(ENVS, { query: 'produccion' }))).toEqual(['Producción'])
    expect(names(buildEnvironmentListView(ENVS, { query: 'PRODUCCIÓN' }))).toEqual(['Producción'])
  })

  it('keeps a space significant, so the query reads as typed', () => {
    expect(names(buildEnvironmentListView(ENVS, { query: 'dev q' }))).toEqual(['dev QA'])
    expect(buildEnvironmentListView(ENVS, { query: 'devq' })).toEqual([])
  })

  it('filters nothing when the query is empty or only whitespace', () => {
    const all = ['Ada', 'dev QA', 'Producción', 'Staging']
    expect(names(buildEnvironmentListView(ENVS, { query: '' }))).toEqual(all)
    expect(names(buildEnvironmentListView(ENVS, { query: '   ' }))).toEqual(all)
  })

  it('yields an empty list when nothing matches', () => {
    expect(buildEnvironmentListView(ENVS, { query: 'nothing here' })).toEqual([])
  })

  it('applies the filter and the sort together', () => {
    expect(names(buildEnvironmentListView(ENVS, { query: 'a', sort: 'asc' }))).toEqual([
      'Ada',
      'dev QA',
      'Staging'
    ])
  })
})

describe('buildEnvironmentListView — the row being edited', () => {
  it('keeps the kept row even when it does not match the query', () => {
    const view = buildEnvironmentListView(ENVS, { query: 'staging', keepId: 'id-ada' })
    expect(names(view)).toEqual(['Ada', 'Staging'])
  })

  it('places the kept row where the active sort puts it', () => {
    const view = buildEnvironmentListView(ENVS, {
      query: 'staging',
      sort: 'desc',
      keepId: 'id-ada'
    })
    expect(names(view)).toEqual(['Staging', 'Ada'])
  })

  it('never duplicates a kept row that already matches', () => {
    const view = buildEnvironmentListView(ENVS, { query: 'staging', keepId: 'id-staging' })
    expect(names(view)).toEqual(['Staging'])
  })

  it('ignores a kept id that belongs to no environment', () => {
    const view = buildEnvironmentListView(ENVS, { query: 'staging', keepId: 'gone' })
    expect(names(view)).toEqual(['Staging'])
  })

  it('ignores a null kept id', () => {
    const view = buildEnvironmentListView(ENVS, { query: 'staging', keepId: null })
    expect(names(view)).toEqual(['Staging'])
  })
})
