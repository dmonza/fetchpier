import {
  CONTAINER_NAME,
  IMAGE_REF,
  LOCAL_URL,
  PUBLIC_FALLBACK_URL,
  imageExists,
  isDockerAvailable,
  pullImage,
  removeContainer,
  startContainer,
  waitForHealth,
  writeSetupState
} from './helpers/docker-httpbin'
import { resolveHttpTarget, shouldRemoveContainer } from './helpers/resolve-http-target'
import { resolveHostPreconditions } from './helpers/host-preconditions'
import { probeHost } from './helpers/probe-host'

// Playwright globalSetup — runs once before any spec, in the main Playwright
// process. Anything written to `process.env` here is inherited by the workers.
//
// It does two things, in order:
//   1. verifies the HOST is fit to run the suite (renderer sandbox, and an OS
//      keyring when the run needs one) — see `host-preconditions.ts`;
//   2. resolves where the suite's HTTP traffic goes.
//
// Both follow the same shape: a pure, unit-tested decision module plus this
// thin I/O caller (logging, env, the state file, container cleanup). Both abort
// the whole invocation rather than let the suite degrade into a partially
// meaningful green.
//
// The container is the STANDARD path, locally and in CI: if the pinned image is
// missing it is fetched automatically, so a fresh clone works with no manual
// preparation. Setting FETCHPIER_TEST_HTTPBIN_URL bypasses the container
// entirely (escape hatch for pointing at a target somebody else manages).
//
// FETCHPIER_TEST_REQUIRE_DOCKER makes anything other than the container a hard
// failure — automation sets it so a gating run can never silently validate
// against the public internet.
//
// All logs are prefixed `[e2e/docker]` so a CI grep can locate them quickly.

const LOG_PREFIX = '[e2e/docker]'
const HOST_PREFIX = '[e2e/host]'

/** Off unless explicitly enabled. `0`, `false` and `no` read as off. */
function flagEnabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase()
  if (!value) return false
  return value !== '0' && value !== 'false' && value !== 'no'
}

/**
 * Verify the host is fit to run the suite, before a single spec executes.
 *
 * Two facts, both properties of the machine rather than of the product: the
 * renderer sandbox (always required — every job that launches the app must
 * exercise the shipped configuration) and an OS keyring (only for runs that
 * reach the workspace-key specs, hence the opt-in flag, mirroring how the HTTP
 * target's strict mode works).
 *
 * Throwing here fails the whole invocation, which is the point: one host fact
 * produces one message instead of every dependent spec failing separately.
 */
async function assertHostPreconditions(): Promise<void> {
  const probe = await probeHost()
  const result = resolveHostPreconditions({
    platform: process.platform,
    sandbox: probe.sandbox,
    requireKeyring: flagEnabled(process.env.FETCHPIER_TEST_REQUIRE_KEYRING),
    keyringBackend: probe.keyringBackend,
    allowUnsandboxed: flagEnabled(process.env.FETCHPIER_TEST_ALLOW_UNSANDBOXED)
  })

  if (result.status === 'unmet') {
    console.error(`${HOST_PREFIX} ${result.message}`)
    throw new Error(result.message)
  }

  // A waiver must never read as a pass. This run is exercising a configuration
  // that does not ship, and the log has to say so where someone scanning a green
  // run will see it.
  for (const entry of result.waived) {
    console.warn(
      `${HOST_PREFIX} WAIVED (${entry.kind}): ${entry.observed}.\n` +
        `${HOST_PREFIX} This run is NOT validating the shipped configuration. The invariant ` +
        `is verified on the platforms that can honor it.`
    )
  }

  // Workers inherit this; specs that need a persisted keystore read it to decide
  // whether they can run at all (see `workspace-keys.spec.ts`).
  process.env.FETCHPIER_TEST_SECRETS_BACKEND = probe.keyringBackend

  if (probe.keyringBackend !== 'os-keychain') {
    // Not fatal here — this run did not ask for a keyring. But the specs that
    // depend on one are about to skip, and a skip nobody announced is
    // indistinguishable from a spec that quietly stopped existing.
    console.warn(
      `${HOST_PREFIX} secrets backend is '${probe.keyringBackend}': keyring-dependent specs ` +
        `will SKIP on this host. They are verified on the platforms with a native keyring — ` +
        `set FETCHPIER_TEST_REQUIRE_KEYRING to make this a hard failure instead.`
    )
  }

  const sandboxNote = probe.sandbox.requested
    ? `${probe.sandbox.renderers.length} renderer(s), sandboxed: ${result.waived.length === 0}`
    : 'the app did not request a sandboxed renderer (sandbox.spec.ts owns that)'
  console.log(`${HOST_PREFIX} ${sandboxNote}; secrets backend '${probe.keyringBackend}'`)
}

export default async function globalSetup(): Promise<void> {
  await assertHostPreconditions()

  const resolution = await resolveHttpTarget({
    envUrl: process.env.FETCHPIER_TEST_HTTPBIN_URL,
    strict: flagEnabled(process.env.FETCHPIER_TEST_REQUIRE_DOCKER),
    localUrl: LOCAL_URL,
    publicUrl: PUBLIC_FALLBACK_URL,
    isDockerAvailable,
    imageExists: () => imageExists(),
    pullImage: () => pullImage(),
    startContainer,
    waitForHealth: () => waitForHealth()
  })

  const { target } = resolution

  // Clean up a container we created but could not bring up, so the next run
  // does not inherit a broken one. Never removes a container that was already
  // running before this run started.
  if (shouldRemoveContainer(target) && removeContainer()) {
    console.warn(`${LOG_PREFIX} removed half-broken container ${CONTAINER_NAME}`)
  }

  if (resolution.status === 'strict-violation') {
    // Abort before a single spec runs. Throwing from globalSetup fails the
    // whole Playwright invocation, which is the point: a degraded run must not
    // produce a green result.
    console.error(`${LOG_PREFIX} ${resolution.message}`)
    throw new Error(resolution.message)
  }

  switch (target.mode) {
    case 'user-provided':
      console.log(
        `${LOG_PREFIX} FETCHPIER_TEST_HTTPBIN_URL already set (${target.url}); skipping the container`
      )
      break

    case 'docker': {
      if (target.pulled) console.log(`${LOG_PREFIX} pulled ${IMAGE_REF}`)
      const verb =
        target.containerAction === 'created'
          ? `created and started container ${CONTAINER_NAME} (${IMAGE_REF})`
          : target.containerAction === 'started'
            ? `started existing container ${CONTAINER_NAME}`
            : `reusing already-running container ${CONTAINER_NAME}`
      console.log(`${LOG_PREFIX} ${verb}`)
      console.log(`${LOG_PREFIX} healthy in ${target.healthMs}ms`)
      // Workers inherit this; `copyWorkspaceFixture` rewrites every fixture's
      // baseUrl from it at copy time.
      process.env.FETCHPIER_TEST_HTTPBIN_URL = target.url
      console.log(`${LOG_PREFIX} using ${target.url}`)
      break
    }

    case 'public':
      // Left unset on purpose: the committed fixtures already carry the public
      // baseUrl, so an unset variable and the fallback are the same thing.
      console.warn(
        `${LOG_PREFIX} ${target.degradedReason?.detail ?? 'container unavailable'}; ` +
          `falling back to ${target.url}`
      )
      break
  }

  await writeSetupState({
    ranAt: new Date().toISOString(),
    mode: target.mode,
    container: target.mode === 'docker' ? CONTAINER_NAME : null
  })
}
