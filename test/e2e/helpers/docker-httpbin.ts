import { execFileSync } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Shared helpers for the Playwright globalSetup / globalTeardown that bring up
// a local httpbin Docker container (`httpbin:local`) and tear it down. The
// orchestration is in `global-setup.ts` and `global-teardown.ts`; this file
// only exposes thin, individually-testable primitives so the orchestration
// stays linear and grep-able.
//
// Everything here uses `execFileSync` (not `exec` with a shell) to avoid
// shell-interpretation surprises across Windows/Linux/macOS and to keep the
// command surface auditable.

/**
 * Shape of `test/httpbin-image.json` — the single source of truth for the
 * pinned target. Nothing else in the repository may restate the digest.
 */
interface HttpbinImageDescriptor {
  image: string
  digest: string
  /** Port published on the host — what the target URL points at. */
  hostPort: number
  /** Port the image itself listens on. Differs per httpbin build. */
  containerPort: number
  containerName: string
}

// Playwright and Vitest both run from the repo root, so `process.cwd()` is
// reliable here. Using it (rather than `import.meta.url` / `__dirname`) keeps
// the helper compatible with whichever module mode the runner's transformer
// picks — the same rationale as `fixtures.ts`.
const DESCRIPTOR_PATH = resolve(process.cwd(), 'test', 'httpbin-image.json')

function readDescriptor(): HttpbinImageDescriptor {
  const raw = readFileSync(DESCRIPTOR_PATH, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<HttpbinImageDescriptor>
  if (
    typeof parsed.image !== 'string' ||
    typeof parsed.digest !== 'string' ||
    typeof parsed.hostPort !== 'number' ||
    typeof parsed.containerPort !== 'number' ||
    typeof parsed.containerName !== 'string'
  ) {
    throw new Error(
      `Malformed pinned-target descriptor at ${DESCRIPTOR_PATH}: expected ` +
        '{ image: string, digest: string, hostPort: number, containerPort: number, containerName: string }'
    )
  }
  if (!parsed.digest.startsWith('sha256:')) {
    throw new Error(
      `Pinned-target descriptor at ${DESCRIPTOR_PATH} must pin an immutable digest ` +
        `(got "${parsed.digest}"). A mutable tag is not acceptable — a run could ` +
        'silently use a different build than the repository declares.'
    )
  }
  return parsed as HttpbinImageDescriptor
}

const DESCRIPTOR = readDescriptor()

export const CONTAINER_NAME = DESCRIPTOR.containerName
/** Immutable reference (`<image>@sha256:…`) — never a mutable tag. */
export const IMAGE_REF = `${DESCRIPTOR.image}@${DESCRIPTOR.digest}`
export const HOST_PORT = DESCRIPTOR.hostPort
export const CONTAINER_PORT = DESCRIPTOR.containerPort
export const LOCAL_URL = `http://localhost:${DESCRIPTOR.hostPort}`
/**
 * The public service the suite degrades to when the container is unavailable
 * and strict mode is off. Developer convenience only — never the target of a
 * gating run.
 */
export const PUBLIC_FALLBACK_URL = 'https://httpbin.org'
export const HEALTH_PATH = '/get'
export const HEALTH_TIMEOUT_MS = 10_000
export const HEALTH_POLL_INTERVAL_MS = 250
/** Pull can cross the network on a cold machine — far slower than the health poll. */
export const PULL_TIMEOUT_MS = 180_000

export type ContainerState = 'running' | 'stopped' | 'absent'

export interface SetupState {
  ranAt: string
  /**
   * - `docker`     — we set FETCHPIER_TEST_HTTPBIN_URL to the local container.
   * - `public`     — fell back to https://httpbin.org (env var left unset).
   * - `user-provided` — operator already had the env var set; we did not touch Docker.
   */
  mode: 'docker' | 'public' | 'user-provided'
  /** Container name we touched, or null if we never reached Docker. */
  container: typeof CONTAINER_NAME | null
}

const STATE_FILE = join(tmpdir(), 'fp-e2e-docker-state.json')

function runDocker(args: string[], timeoutMs?: number): { stdout: string; stderr: string } {
  // `stdio: 'pipe'` so we capture both streams and never inherit the parent
  // tty (otherwise Docker can prompt for login on some installs).
  try {
    const stdout = execFileSync('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs })
    })
    return { stdout, stderr: '' }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? '')
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '')
    throw Object.assign(new Error(e.message), { stdout, stderr })
  }
}

/** True iff `docker --version` returns successfully. */
export function isDockerAvailable(): boolean {
  try {
    runDocker(['--version'])
    return true
  } catch {
    return false
  }
}

/** True iff the pinned image is already present locally. */
export function imageExists(image = IMAGE_REF): boolean {
  try {
    runDocker(['image', 'inspect', image, '--format', '{{.Id}}'])
    return true
  } catch {
    return false
  }
}

/**
 * Fetch the pinned image by digest. Throws on failure so the caller can decide
 * whether that is fatal (strict mode) or degrades to the public fallback.
 *
 * Pulling by digest rather than by tag is what makes the run reproducible: the
 * content is fixed even though the upstream tag is not.
 */
export function pullImage(image = IMAGE_REF): void {
  runDocker(['pull', '--quiet', image], PULL_TIMEOUT_MS)
}

/** Inspect the container's current state. */
export function containerState(name = CONTAINER_NAME): ContainerState {
  try {
    const { stdout } = runDocker(['inspect', '-f', '{{.State.Running}}', name])
    return stdout.trim() === 'true' ? 'running' : 'stopped'
  } catch {
    return 'absent'
  }
}

/**
 * Start the container in whatever state-transition the current situation
 * requires:
 *   absent  → `docker run -d --name <container> -p <port>:<port> <image>@<digest>`
 *   stopped → `docker start <container>`
 *   running → no-op
 *
 * Returns the action taken (useful for logging in `global-setup.ts`).
 */
export function startContainer(): 'created' | 'started' | 'already-running' {
  const state = containerState()
  if (state === 'running') return 'already-running'
  if (state === 'stopped') {
    runDocker(['start', CONTAINER_NAME])
    return 'started'
  }
  runDocker([
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `${HOST_PORT}:${CONTAINER_PORT}`,
    IMAGE_REF
  ])
  return 'created'
}

/** Force-remove the container; best-effort. Returns true iff removed. */
export function removeContainer(): boolean {
  try {
    runDocker(['rm', '-f', CONTAINER_NAME])
    return true
  } catch {
    return false
  }
}

/**
 * Poll the healthcheck URL until any HTTP response comes back or the timeout
 * elapses. Returns the elapsed ms on success; throws on timeout. Any HTTP
 * status counts as healthy — the container listening is enough; the spec
 * suites assert on response semantics themselves.
 */
export async function waitForHealth(
  url = `${LOCAL_URL}${HEALTH_PATH}`,
  timeoutMs = HEALTH_TIMEOUT_MS,
  intervalMs = HEALTH_POLL_INTERVAL_MS
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    const started = Date.now()
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 1_500)
      try {
        const res = await fetch(url, { signal: controller.signal })
        // Drain the body so the socket can return to the pool — keeps logs
        // clean of "ResponseAborted" warnings under undici.
        await res.text().catch(() => '')
        return Date.now() - started
      } finally {
        clearTimeout(t)
      }
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')
  throw new Error(`healthcheck timed out after ${timeoutMs}ms (last error: ${reason})`)
}

export async function writeSetupState(state: SetupState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

export async function readSetupState(): Promise<SetupState | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    return JSON.parse(raw) as SetupState
  } catch {
    return null
  }
}

export async function clearSetupState(): Promise<void> {
  await fs.rm(STATE_FILE, { force: true })
}
