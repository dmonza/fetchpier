import { describe, expect, it } from 'vitest'
import { labelSendError } from './send-error'

const CANCELLED = 'Request cancelado'

describe('labelSendError', () => {
  it('translates the engine cancellation after a user cancel', () => {
    expect(labelSendError('Request cancelled', true, CANCELLED)).toBe(CANCELLED)
  })

  it('keeps the engine cancellation as is when the user did not cancel', () => {
    expect(labelSendError('Request cancelled', false, CANCELLED)).toBe('Request cancelled')
  })

  it('keeps any other failure, even after a user cancel', () => {
    expect(labelSendError('timed out after 30 s', true, CANCELLED)).toBe('timed out after 30 s')
    expect(labelSendError('connect ECONNREFUSED', false, CANCELLED)).toBe('connect ECONNREFUSED')
  })

  it.each([undefined, null, ''])('reports no error for %j', (error) => {
    expect(labelSendError(error, true, CANCELLED)).toBeNull()
  })
})
