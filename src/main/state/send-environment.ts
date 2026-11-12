/**
 * The environment a send resolves against, as the renderer last set it
 * (`cookies:setActiveEnvironment`). It can differ from workspace-state's
 * persisted selection: a fresh workspace or clone shows and sends from an
 * environment it never persisted. Everything that must agree with the send —
 * the send itself and the client-certificate preview — reads it from here.
 */
let sendEnvironmentId: string | null = null

export function setSendEnvironmentId(envId: string | null): void {
  sendEnvironmentId = envId
}

export function getSendEnvironmentId(): string | null {
  return sendEnvironmentId
}
