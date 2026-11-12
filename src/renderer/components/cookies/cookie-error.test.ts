import { describe, expect, it } from 'vitest'
import { cookieErrorText } from './cookie-error'

const t = (key: string): string => `t:${key}`

describe('cookieErrorText (ENG-37)', () => {
  it('translates an unreadable jar, whatever wraps its token', () => {
    const err = new Error(
      "Error invoking remote method 'cookies:list': Error: COOKIE_JAR_UNREADABLE: /ws/cookies.json: bad json"
    )
    expect(cookieErrorText(err, t)).toBe('t:cookies.errors.jarUnreadable')
  })

  it('keeps the message of any other failure', () => {
    expect(cookieErrorText(new Error('disk full'), t)).toBe('disk full')
    expect(cookieErrorText('plain text', t)).toBe('plain text')
  })
})
