import type { AuthConfig } from '../types'

/**
 * The header materialized ("echoed") into the executable request by an auth
 * scheme: `Authorization: Bearer …`, `Authorization: Basic user:pass`, or a
 * custom api-key header.
 */
export interface AuthEchoHeader {
  name: string
  value: string
}

/** The query parameter materialized by an api-key (location: query) scheme. */
export interface AuthEchoQuery {
  key: string
  value: string
}

/**
 * The deterministic echo a given auth scheme materializes into the executable
 * request text. A scheme produces at most one of `header` / `query`; `none`
 * (and any empty/under-specified scheme) produces neither.
 *
 * Single source of truth for REQ-0083, consumed by three call sites:
 * - the serializer, to WRITE the echo into the `.http` file;
 * - the core parser, to COMPUTE the echo it must strip from the editable set
 *   on load (reconciliation);
 * - the renderer, to PROJECT the read-only managed header / parameter row.
 *
 * Values are carried VERBATIM, including `{{variable}}` references — resolution
 * happens later in the send pipeline, never here (REQ §4 assumptions, §6.5).
 * Basic credentials are NOT base64-encoded in the echo; the encoding happens at
 * send time in `applyAuth` (REQ §5.2).
 */
export interface AuthEcho {
  header?: AuthEchoHeader
  query?: AuthEchoQuery
}

/** Computes the echo (header or query parameter) a scheme materializes, if any. */
export function authEcho(auth: AuthConfig | undefined | null): AuthEcho {
  if (!auth) return {}
  switch (auth.type) {
    case 'bearer':
      return auth.token.trim() !== ''
        ? { header: { name: 'Authorization', value: `Bearer ${auth.token}` } }
        : {}
    case 'basic':
      return auth.username.trim() !== '' || auth.password.trim() !== ''
        ? { header: { name: 'Authorization', value: `Basic ${auth.username}:${auth.password}` } }
        : {}
    case 'api-key':
      if (auth.key.trim() === '') return {}
      return auth.location === 'query'
        ? { query: { key: auth.key, value: auth.value } }
        : { header: { name: auth.key, value: auth.value } }
    case 'none':
    default:
      return {}
  }
}
