// The HTTP-target decision tree for the Playwright/Electron suite.
//
// This module is deliberately **pure**: every collaborator is injected and it
// touches neither Docker, the network, the filesystem, nor `process.env`. All
// of that lives in `global-setup.ts`, which is a thin caller. The split exists
// so the tree — which decides whether a run talks to a controlled container or
// to the public internet — is unit-testable, because a run that silently
// degrades to the public service is the exact defect this guard prevents.
//
// Precedence (see the requirement "Continuous integration on every commit with
// a self-hosted HTTP test target", §6.4):
//   1. explicit override → honored verbatim, no container work, exempt from strict mode
//   2. container → fetch the pinned image if absent, start-or-reuse, health-check
//   3. fallback → the public service, with a warning
//
// Strict mode requires having reached step 2. Landing anywhere else is a hard
// failure, surfaced to the caller as a `strict-violation` result rather than a
// thrown error, so the policy decision stays testable without exception plumbing.

export type ResolvedMode = 'user-provided' | 'docker' | 'public'

export type ContainerAction = 'created' | 'started' | 'already-running'

/** Why the container path was not reached. `detail` carries the underlying message. */
export type DegradationReason = {
  kind: 'no-runtime' | 'pull-failed' | 'start-failed' | 'health-failed'
  detail: string
}

export interface ResolvedTarget {
  mode: ResolvedMode
  /** The URL the specs will hit. */
  url: string
  /** Whether the pinned image had to be fetched. Absent for `user-provided`. */
  pulled?: boolean
  /** The container state transition. Present once the container actually started. */
  containerAction?: ContainerAction
  /** Health-check duration in ms. Only for `docker`. */
  healthMs?: number
  /** Present when the container path was attempted and failed. Only for `public`. */
  degradedReason?: DegradationReason
}

export interface HttpTargetDeps {
  /** Raw value of the target-URL override; blank or whitespace counts as unset. */
  envUrl: string | undefined
  /** When true, anything but the container path is a hard failure. */
  strict: boolean
  localUrl: string
  publicUrl: string
  isDockerAvailable(): boolean
  imageExists(): boolean
  pullImage(): void
  startContainer(): ContainerAction
  waitForHealth(): Promise<number>
}

export type TargetResolution =
  | { status: 'ok'; target: ResolvedTarget }
  | {
      status: 'strict-violation'
      target: ResolvedTarget
      reason: DegradationReason
      /** Ready-to-print explanation naming the resolved target and the reason. */
      message: string
    }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const REASON_PHRASE: Record<DegradationReason['kind'], string> = {
  'no-runtime': 'no container runtime is available',
  'pull-failed': 'the pinned image could not be fetched',
  'start-failed': 'the container could not be started',
  'health-failed': 'the container never became healthy'
}

function violation(target: ResolvedTarget, reason: DegradationReason): TargetResolution {
  return {
    status: 'strict-violation',
    target,
    reason,
    message:
      `Refusing to run: the HTTP target resolved to ${target.url} because ` +
      `${REASON_PHRASE[reason.kind]} (${reason.detail}). Strict mode is on, so ` +
      'degrading to the public service is not acceptable — the suite would be ' +
      'validating against the internet instead of the pinned target. Start the ' +
      'container runtime, or unset the strict-mode flag to allow the fallback.'
  }
}

/**
 * Resolve where the suite's HTTP traffic goes. Never throws for a policy
 * decision — a strict violation comes back as a result the caller reports.
 */
export async function resolveHttpTarget(deps: HttpTargetDeps): Promise<TargetResolution> {
  const override = deps.envUrl?.trim()
  if (override) {
    // A deliberate operator act. Exempt from strict mode on purpose: the guard
    // asks "did the harness reach the container?", and here the answer is
    // "no, because you told it not to try".
    return { status: 'ok', target: { mode: 'user-provided', url: override } }
  }

  const degrade = (reason: DegradationReason, partial: Partial<ResolvedTarget> = {}) => {
    const target: ResolvedTarget = {
      mode: 'public',
      url: deps.publicUrl,
      degradedReason: reason,
      ...partial
    }
    return deps.strict ? violation(target, reason) : { status: 'ok' as const, target }
  }

  if (!deps.isDockerAvailable()) {
    return degrade({ kind: 'no-runtime', detail: 'docker is not on PATH or not responding' })
  }

  let pulled = false
  if (!deps.imageExists()) {
    try {
      deps.pullImage()
      pulled = true
    } catch (err) {
      return degrade({ kind: 'pull-failed', detail: messageOf(err) })
    }
  }

  let containerAction: ContainerAction
  try {
    containerAction = deps.startContainer()
  } catch (err) {
    return degrade({ kind: 'start-failed', detail: messageOf(err) }, { pulled })
  }

  try {
    const healthMs = await deps.waitForHealth()
    return {
      status: 'ok',
      target: { mode: 'docker', url: deps.localUrl, pulled, containerAction, healthMs }
    }
  } catch (err) {
    return degrade({ kind: 'health-failed', detail: messageOf(err) }, { pulled, containerAction })
  }
}

/**
 * Whether the caller should remove the container after a failed attempt.
 *
 * Mirrors the pre-existing rule: clean up what we created, never remove a
 * container that was already running before this run started (it wasn't ours).
 * A start failure implies it was not running, since a running container makes
 * `startContainer` return `already-running` instead of throwing.
 */
export function shouldRemoveContainer(target: ResolvedTarget): boolean {
  const kind = target.degradedReason?.kind
  if (kind === 'start-failed') return true
  if (kind === 'health-failed') return target.containerAction !== 'already-running'
  return false
}
