import type { AuthConfig } from '@shared/types'
import type { TlsFacts } from '../requests/connection-facts'

/**
 * Everything the findings rules may look at, all of it already observed by the
 * send. Values inside are for the rules' own checks; the evaluation reports names
 * only.
 */
export interface FindingsExchange {
  /** URL of the hop that delivered the final response. */
  finalUrl: string
  /** That hop's request headers as sent, in order. */
  requestHeaders: Array<[string, string]>
  response: {
    headers: Record<string, string>
    /** Whether the final response carried a non-empty body. */
    hasBody: boolean
  }
  /** Every hop of the send, in order: its URL and the `Set-Cookie` its response carried. */
  hops: Array<{ url: string; setCookie: string[] }>
  /** TLS facts of the connection that delivered the final response, when captured. */
  tls?: TlsFacts
  /** Whether certificate verification was on for the send. */
  verifySsl: boolean
  /** The request's auth scheme, used only to recognize its own header or parameter by name. */
  auth?: AuthConfig
}
