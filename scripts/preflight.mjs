#!/usr/bin/env node
/**
 * preflight — REQ-0055 §4.6.4 orchestrator.
 *
 * Runs the full pre-deploy pipeline. Each step inherits stdio so the
 * developer sees the underlying command output verbatim. Aborts on the
 * first failure.
 *
 * Steps:
 *   1. audit:shipped                   — advisories (moderate+) and runtime currency
 *   2. generate:licenses               — refresh THIRD_PARTY_LICENSES.txt
 *   3. prebuild:dts --check            — fail if fp-api generated dts is stale
 *   4. post-req                        — typecheck + lint + tests + coverage + smoke
 *   5. test:e2e                        — full UI suite
 *   6. build                           — verify the bundle actually compiles
 *
 * Exit codes:
 *   0  pipeline green — ready to package / ship
 *   1  a step failed; the failing step is the last line of stderr
 */
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const REPO_ROOT = process.cwd()
const isWindows = process.platform === 'win32'
const NPM = isWindows ? 'npm.cmd' : 'npm'

let stepCounter = 0
function announce(title) {
  stepCounter += 1
  process.stdout.write(`\n\x1b[35m▶ [preflight ${stepCounter}] ${title}\x1b[0m\n`)
}

function runStep(title, cmd, args) {
  announce(title)
  const started = performance.now()
  // shell:true with a single command string avoids the DEP0190 deprecation
  // (Node 24+) that fires when args are passed as a separate array under
  // shell:true. All callers here use static, shell-safe args (no user input).
  const result = spawnSync([cmd, ...args].join(' '), {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    shell: true
  })
  const elapsed = ((performance.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    process.stderr.write(`\n\x1b[31m✗ FAILED: ${title} (after ${elapsed}s)\x1b[0m\n`)
    process.exit(1)
  }
  process.stdout.write(`\x1b[32m✓ ${title} (${elapsed}s)\x1b[0m\n`)
}

const totalStart = performance.now()

// Step 1: what ships must be clean and current. Same check as the nightly; see
// scripts/audit/shipped-runtime.mjs.
runStep('audit:shipped', NPM, ['run', 'audit:shipped'])

runStep('generate:licenses', NPM, ['run', 'generate:licenses'])
runStep('prebuild:dts (--check)', NPM, ['run', 'prebuild:dts'])
runStep('post-req', NPM, ['run', 'post-req'])
runStep('test:e2e (full UI suite)', NPM, ['run', 'test:e2e'])
runStep('build', NPM, ['run', 'build'])

const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(1)
process.stdout.write(
  `\n\x1b[32m✔ preflight green in ${totalElapsed}s — bundle in out/ is ready to package\x1b[0m\n`
)
