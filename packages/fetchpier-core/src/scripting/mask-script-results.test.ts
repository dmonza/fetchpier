import { describe, expect, it } from 'vitest'
import type { ScriptResultsBundle } from '@shared/types'
import { createValueMask, maskScriptResults } from './mask-script-results'

const mask = createValueMask({ token: 's3cr3t-token', apiKey: 'AK-123' })

describe('createValueMask', () => {
  it('replaces every occurrence of each value with its named mask', () => {
    expect(mask('a s3cr3t-token b s3cr3t-token AK-123')).toBe(
      'a {secret:token} b {secret:token} {secret:apiKey}'
    )
  })

  it('masks the longer value first when one contains another', () => {
    const m = createValueMask({ short: 'abc', long: 'abcdef' })
    expect(m('xabcdefx abc')).toBe('x{secret:long}x {secret:short}')
  })

  it('never masks on an empty value', () => {
    expect(createValueMask({ empty: '' })('unchanged')).toBe('unchanged')
  })

  it('is the identity with no values', () => {
    expect(createValueMask({})('anything')).toBe('anything')
  })
})

describe('maskScriptResults', () => {
  const bundle: ScriptResultsBundle = {
    preRequest: {
      success: true,
      logs: [
        { level: 'log', args: ['token is', 's3cr3t-token'], timestamp: 't' },
        {
          level: 'warn',
          args: [{ nested: { deep: ['AK-123'] }, n: 1, ok: true, nil: null }],
          timestamp: 't'
        }
      ],
      testResults: [],
      environmentChanges: { set: { token: 's3cr3t-token', plain: 'v' }, removed: [] }
    },
    postResponse: {
      success: false,
      error: { message: 'boom s3cr3t-token', stack: 'Error: boom s3cr3t-token\n  at x' },
      logs: [],
      testResults: [
        { name: 'compares s3cr3t-token', passed: false, error: 'expected s3cr3t-token to equal x' }
      ]
    }
  }

  it('masks log arguments, nested values, test names and messages, and script errors', () => {
    const out = maskScriptResults(bundle, mask)!
    expect(out.preRequest!.logs[0].args).toEqual(['token is', '{secret:token}'])
    expect(out.preRequest!.logs[1].args).toEqual([
      { nested: { deep: ['{secret:apiKey}'] }, n: 1, ok: true, nil: null }
    ])
    expect(out.postResponse!.testResults[0]).toEqual({
      name: 'compares {secret:token}',
      passed: false,
      error: 'expected {secret:token} to equal x'
    })
    expect(out.postResponse!.error).toEqual({
      message: 'boom {secret:token}',
      stack: 'Error: boom {secret:token}\n  at x'
    })
  })

  it('masks the environment-change copies carried in the section, values only', () => {
    const out = maskScriptResults(bundle, mask)!
    expect(out.preRequest!.environmentChanges).toEqual({
      set: { token: '{secret:token}', plain: 'v' },
      removed: []
    })
  })

  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(bundle)
    maskScriptResults(bundle, mask)
    expect(JSON.stringify(bundle)).toBe(snapshot)
  })

  it('passes an absent bundle through', () => {
    expect(maskScriptResults(undefined, mask)).toBeUndefined()
  })
})
