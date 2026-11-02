import {
  CONTAINER_NAME,
  clearSetupState,
  readSetupState,
  removeContainer
} from './helpers/docker-httpbin'

// Playwright globalTeardown — runs once after the entire suite finishes, in
// the main Playwright process. We use a tmpdir state file (written by
// globalSetup) to know whether we touched Docker at all this run; without it,
// teardown is a no-op.
//
// User decision: always remove the container, even if it was already running
// when setup started. See PLAN-0078 §Decisions.

const LOG_PREFIX = '[e2e/docker]'

export default async function globalTeardown(): Promise<void> {
  const state = await readSetupState()
  if (!state) {
    // Setup never ran (e.g. user invoked Playwright with a custom config), or
    // setup ran but failed before persisting state. Nothing to clean up.
    return
  }

  try {
    if (state.mode === 'docker' && state.container === CONTAINER_NAME) {
      const removed = removeContainer()
      if (removed) {
        console.log(`${LOG_PREFIX} removed container ${CONTAINER_NAME}`)
      } else {
        console.warn(`${LOG_PREFIX} failed to remove container ${CONTAINER_NAME} (already gone?)`)
      }
    }
  } finally {
    await clearSetupState()
  }
}
