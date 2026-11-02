import type { WorkspaceHttpSettings } from '@shared/types'
import { DEFAULT_BINARY_FILE_LIMITS } from '@shared/types'

export const DEFAULT_WORKSPACE_HTTP_SETTINGS: WorkspaceHttpSettings = {
  httpVersion: 'auto',
  verifySsl: true,
  followRedirects: true,
  maxRedirects: 10,
  followAuthorizationOnRedirect: false,
  encodeUrl: true,
  disableCookieJar: false,
  binaryFileLimits: DEFAULT_BINARY_FILE_LIMITS
}
