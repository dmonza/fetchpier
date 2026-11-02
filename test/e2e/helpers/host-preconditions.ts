import type { KeystoreBackend } from '../../../src/shared/types'
import { isOsSandboxed, type SandboxObservation } from './renderer-sandbox'

// Whether this machine is fit to run the suite.
//
// Deliberately **pure**: every collaborator is injected and it touches no
// process, filesystem, or environment. The I/O half lives in `probe-host.ts`
// and `global-setup.ts`. The split is the same one `resolve-http-target.ts`
// uses, and it matters more here than anywhere else in the harness: these
// decisions only ever execute on the Linux runner, which is the one platform
// the maintainer cannot run locally. A policy that can only be verified by
// pushing to CI is a policy that ships unverified.
//
// A precondition is a property of the *host*, never of the product. An unmet
// one aborts the run before any spec, because the alternative — the suite
// degrading into a partially meaningful green — is the failure mode the whole
// guard exists to prevent.

export type PreconditionKind = 'renderer-sandbox' | 'os-keyring'

export interface UnmetPrecondition {
  kind: PreconditionKind
  /** What was actually observed, ready to print. */
  observed: string
  /** The concrete action that satisfies it. */
  remedy: string
}

export interface HostPreconditionInput {
  platform: NodeJS.Platform
  sandbox: SandboxObservation
  /** Only the full suite touches secrets; the smoke selection does not. */
  requireKeyring: boolean
  keyringBackend: KeystoreBackend
  /**
   * Let a host that genuinely cannot sandbox a renderer run the rest of the
   * suite anyway. The sandbox is then reported as **waived**, never as met.
   *
   * Opt-OUT while every other precondition is opt-IN, and that asymmetry is
   * deliberate: relaxing a security invariant must be an explicit act, never
   * something a forgotten flag produces by default. The invariant itself is
   * verified on the platforms that can honor it.
   */
  allowUnsandboxed: boolean
}

export type HostPreconditionResult =
  | { status: 'ok'; waived: UnmetPrecondition[] }
  | { status: 'unmet'; unmet: UnmetPrecondition[]; message: string }

const SANDBOX_REMEDY =
  'The renderer must run inside the OS sandbox, as it does in a shipped build. ' +
  'On a Linux CI host the usual cause is the runtime’s privileged sandbox helper ' +
  'being owned by the installing user rather than root, which makes its setuid ' +
  'bit inert: the engine then disables the sandbox instead of failing. Run ' +
  '`scripts/ci/enable-chrome-sandbox.sh` after installing dependencies. Allowing ' +
  'unprivileged user namespaces alone was measured NOT to be sufficient. If the ' +
  'host is known good, check instead that the app still requests a sandboxed ' +
  'renderer — sandbox.spec.ts tells the two apart. Do NOT relax the assertion: ' +
  'an unsandboxed renderer means the suite is validating a configuration that ' +
  'never ships.'

const KEYRING_REMEDY =
  'Workspace-key specs need a real OS keyring; without one the secrets subsystem ' +
  'correctly holds keys in memory and never writes the keystore. Run the suite ' +
  'through the keyring bootstrap, which creates the keyring directory and adopts ' +
  'the daemon’s environment (starting the daemon and discarding its output does ' +
  'neither, and still exits 0):\n' +
  '  xvfb-run -a dbus-run-session -- scripts/ci/run-with-keyring.sh npm run test:e2e'

function describeRenderer(
  platform: NodeJS.Platform,
  renderer: SandboxObservation['renderers'][number]
): string {
  return platform === 'linux'
    ? `pid ${renderer.pid} reports Seccomp: ${renderer.seccomp ?? 'absent'}`
    : `pid ${renderer.pid} reports sandboxed: ${renderer.sandboxed ?? 'absent'}`
}

function checkSandbox(input: HostPreconditionInput): UnmetPrecondition | null {
  // The product asked for an unsandboxed renderer. That is not a host fault and
  // must not be reported as one — `sandbox.spec.ts` owns that regression.
  if (!input.sandbox.requested) return null

  if (input.sandbox.renderers.length === 0) {
    return {
      kind: 'renderer-sandbox',
      observed: 'no renderer processes were observed while the app was running',
      remedy: SANDBOX_REMEDY
    }
  }

  const offenders = input.sandbox.renderers.filter(
    (renderer) => !isOsSandboxed(input.platform, renderer)
  )
  if (offenders.length === 0) return null

  return {
    kind: 'renderer-sandbox',
    observed: `the renderer is not sandboxed by the OS — ${offenders
      .map((renderer) => describeRenderer(input.platform, renderer))
      .join('; ')}`,
    remedy: SANDBOX_REMEDY
  }
}

function checkKeyring(input: HostPreconditionInput): UnmetPrecondition | null {
  if (!input.requireKeyring) return null
  if (input.keyringBackend === 'os-keychain') return null

  return {
    kind: 'os-keyring',
    observed: `the secrets backend resolved to '${input.keyringBackend}', not 'os-keychain'`,
    remedy: KEYRING_REMEDY
  }
}

/**
 * Decide whether the host can run the suite. Never throws for a policy
 * decision — an unmet precondition comes back as a result the caller reports,
 * exactly like the HTTP target's strict violation.
 */
export function resolveHostPreconditions(input: HostPreconditionInput): HostPreconditionResult {
  const sandbox = checkSandbox(input)

  // The waiver covers the sandbox and nothing else: a host that cannot sandbox
  // is a known, declared limitation of some CI runners, whereas a missing
  // keyring is always fixable and stays fatal.
  const waived = sandbox && input.allowUnsandboxed ? [sandbox] : []

  const unmet = [waived.length === 0 ? sandbox : null, checkKeyring(input)].filter(
    (entry): entry is UnmetPrecondition => entry !== null
  )

  if (unmet.length === 0) return { status: 'ok', waived }

  const body = unmet.map((entry) => `  • ${entry.observed}\n    ${entry.remedy}`).join('\n\n')

  return {
    status: 'unmet',
    unmet,
    message:
      `Refusing to run: ${unmet.length} host precondition${unmet.length === 1 ? '' : 's'} ` +
      `not met on this machine.\n\n${body}`
  }
}
