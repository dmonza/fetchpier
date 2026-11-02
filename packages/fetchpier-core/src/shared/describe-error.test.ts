import { describe, expect, it } from 'vitest'
import { describeError, NO_REPORTED_REASON } from './describe-error'
import { CoreError } from './context'

/**
 * The rule this file exists to defend: a reason handed to the user is never
 * empty. The failure that motivated it — every address of a multi-address host
 * refused — arrives as an aggregated error whose own message is empty and whose
 * detail lives in its `errors` list, so reading only `.message` renders nothing
 * at all and the send looks like it never happened.
 */
describe('describeError', () => {
  describe('a message, when there is one, is authoritative', () => {
    it('returns a non-empty message verbatim', () => {
      expect(describeError(new Error('connect ECONNREFUSED 127.0.0.1:8082'))).toBe(
        'connect ECONNREFUSED 127.0.0.1:8082'
      )
    })

    it('keeps a CoreError message and does not reach for its code', () => {
      expect(describeError(new CoreError('SCRIPT_FAILED', 'pre-request script failed'))).toBe(
        'pre-request script failed'
      )
    })

    it('treats a whitespace-only message as absent', () => {
      const err = Object.assign(new Error('   '), { code: 'ECONNRESET' })
      expect(describeError(err)).toBe('ECONNRESET')
    })
  })

  describe('an aggregated failure reports every cause', () => {
    it('joins the causes in the order they were attempted', () => {
      const err = new AggregateError(
        [
          new Error('connect ECONNREFUSED ::1:8082'),
          new Error('connect ECONNREFUSED 127.0.0.1:8082')
        ],
        ''
      )
      expect(describeError(err)).toBe(
        'connect ECONNREFUSED ::1:8082; connect ECONNREFUSED 127.0.0.1:8082'
      )
    })

    it('describes each cause by the same rules', () => {
      const err = new AggregateError(
        [
          Object.assign(new Error(''), { code: 'ETIMEDOUT' }),
          Object.assign(new Error(''), { code: 'ECONNREFUSED' })
        ],
        ''
      )
      expect(describeError(err)).toBe('ETIMEDOUT; ECONNREFUSED')
    })

    it('does not deduplicate identical causes', () => {
      const err = new AggregateError([new Error('same'), new Error('same')], '')
      expect(describeError(err)).toBe('same; same')
    })

    it('falls through to the code when the cause list is empty', () => {
      const err = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
      expect(describeError(err)).toBe('ECONNREFUSED')
    })

    it('describes a nested aggregate recursively', () => {
      const inner = new AggregateError([new Error('inner a'), new Error('inner b')], '')
      const outer = new AggregateError([inner, new Error('outer')], '')
      expect(describeError(outer)).toBe('inner a; inner b; outer')
    })

    it('terminates on a self-referential aggregate', () => {
      const err = new AggregateError([], '')
      ;(err as { errors: unknown[] }).errors.push(err)
      expect(describeError(err)).toBe(NO_REPORTED_REASON)
    })
  })

  describe('what is left when there is neither message nor cause', () => {
    it('returns the code', () => {
      expect(describeError(Object.assign(new Error(''), { code: 'ENOTFOUND' }))).toBe('ENOTFOUND')
    })

    it('returns the fixed reason for an error carrying nothing', () => {
      expect(describeError(new Error(''))).toBe(NO_REPORTED_REASON)
    })
  })

  describe('values that are not errors at all', () => {
    it('returns a non-empty string as itself', () => {
      expect(describeError('socket hang up')).toBe('socket hang up')
    })

    it('renders a number', () => {
      expect(describeError(500)).toBe('500')
    })

    it.each([
      ['an empty string', ''],
      ['a blank string', '   '],
      ['null', null],
      ['undefined', undefined]
    ])('returns the fixed reason for %s', (_label, value) => {
      expect(describeError(value)).toBe(NO_REPORTED_REASON)
    })

    it('does not surface a plain object as its default stringification', () => {
      expect(describeError({ status: 'down' })).toBe(NO_REPORTED_REASON)
    })

    it('describes a symbol by its own text rather than throwing on it', () => {
      expect(describeError(Symbol('boom'))).toBe('Symbol(boom)')
    })

    it('never throws when reading the value itself throws', () => {
      const hostile = {
        get message(): string {
          throw new Error('unreadable')
        },
        toString(): string {
          throw new Error('unreadable')
        }
      }
      expect(describeError(hostile)).toBe(NO_REPORTED_REASON)
    })
  })

  it('never returns an empty string, whatever it is given', () => {
    const inputs: unknown[] = [
      new Error(''),
      new Error('   '),
      new AggregateError([], ''),
      new AggregateError([new Error('')], ''),
      '',
      '   ',
      null,
      undefined,
      0,
      false,
      {},
      [],
      Symbol('x')
    ]
    for (const input of inputs) {
      expect(describeError(input).length).toBeGreaterThan(0)
    }
  })
})
