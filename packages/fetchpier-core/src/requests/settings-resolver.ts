import type { RequestSettings, SettingValue, WorkspaceHttpSettings } from '@shared/types'

type FieldMap = {
  [K in keyof WorkspaceHttpSettings]: SettingValue<WorkspaceHttpSettings[K]> | undefined
}

function pick<T>(override: SettingValue<T> | undefined, fallback: T): T {
  if (!override || override.inherit === true) return fallback
  return override.value
}

/**
 * Combines per-request overrides with workspace defaults. For each field, the
 * request value wins only if `inherit: false`; otherwise the workspace value is used.
 */
export function resolveSettings(
  requestSettings: RequestSettings | undefined,
  workspaceSettings: WorkspaceHttpSettings
): WorkspaceHttpSettings {
  const r: FieldMap = {
    httpVersion: requestSettings?.httpVersion,
    verifySsl: requestSettings?.verifySsl,
    followRedirects: requestSettings?.followRedirects,
    maxRedirects: requestSettings?.maxRedirects,
    followAuthorizationOnRedirect: requestSettings?.followAuthorizationOnRedirect,
    encodeUrl: requestSettings?.encodeUrl,
    disableCookieJar: requestSettings?.disableCookieJar
  }
  return {
    httpVersion: pick(r.httpVersion, workspaceSettings.httpVersion),
    verifySsl: pick(r.verifySsl, workspaceSettings.verifySsl),
    followRedirects: pick(r.followRedirects, workspaceSettings.followRedirects),
    maxRedirects: pick(r.maxRedirects, workspaceSettings.maxRedirects),
    followAuthorizationOnRedirect: pick(
      r.followAuthorizationOnRedirect,
      workspaceSettings.followAuthorizationOnRedirect
    ),
    encodeUrl: pick(r.encodeUrl, workspaceSettings.encodeUrl),
    disableCookieJar: pick(r.disableCookieJar, workspaceSettings.disableCookieJar),
    // Workspace-only fields (no per-request override). Pass through unchanged.
    ...(workspaceSettings.tls !== undefined ? { tls: workspaceSettings.tls } : {}),
    ...(workspaceSettings.binaryFileLimits !== undefined
      ? { binaryFileLimits: workspaceSettings.binaryFileLimits }
      : {}),
    ...(workspaceSettings.findings !== undefined ? { findings: workspaceSettings.findings } : {})
  }
}

/** Returns how many fields are actively overridden (`inherit: false`). */
export function countOverrides(settings: RequestSettings | undefined): number {
  if (!settings) return 0
  let n = 0
  for (const v of Object.values(settings)) {
    if (v && v.inherit === false) n++
  }
  return n
}
