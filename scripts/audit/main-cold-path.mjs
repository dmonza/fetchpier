/**
 * main-cold-path — the startup artifact must not evaluate a heavy dependency.
 *
 * The main process cannot create a window until it has finished evaluating its
 * modules: evaluation is synchronous and the runtime cannot deliver its
 * readiness signal while the thread is busy. Every dependency reachable from
 * `src/main/index.ts` therefore postpones the first window. Measured on the
 * build this check was written against, the graph that used to be reachable
 * cost ~212 ms, and moving it off took the window from ~354 ms to ~156 ms —
 * essentially the platform floor.
 *
 * That gain degrades silently: one convenient `import` at the top of any module
 * the startup path already reaches restores the whole cost, with no test failing
 * and nothing visibly broken. So it is enforced here instead of documented.
 *
 * How it works: the build emits each deferred `import()` as its own artifact, so
 * `out/main/index.js` contains `require()` calls for exactly the dependencies the
 * startup path evaluates eagerly. This asserts none of them is on the list below.
 *
 * Companion of `audit:coldpath`, which enforces the same idea for the renderer's
 * first-paint path. Run as `npm run audit:maincoldpath` (wired into `postbuild`).
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ENTRY = resolve(process.cwd(), 'out', 'main', 'index.js')

/**
 * Dependencies that must not be evaluated before the window exists, with the
 * reason each one is on the list. A module that genuinely needs one of these
 * belongs in the deferred set, not on an allowlist.
 */
export const DISALLOWED = {
  '@fetchpier/core':
    'the business-layer barrel re-exports the request domain, which pulls the network client (~200 ms). Use the narrow `@fetchpier/core/atomic-write` subpath, or defer the module.',
  undici: 'the network client — nothing needs it until the user sends a request.',
  chokidar: 'the filesystem watcher — nothing needs it until a workspace is open.',
  semver: 'version comparison — nothing needs it until an update check runs.'
}

/** Every bare module specifier the artifact requires at evaluation time. */
export function externalRequires(source) {
  const found = new Set()
  const pattern = /require\(\s*["']([^"']+)["']\s*\)/g
  for (const [, specifier] of source.matchAll(pattern)) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue
    found.add(specifier)
  }
  return found
}

/**
 * A specifier violates the rule when it is a disallowed package itself. A
 * *subpath* of one does not: the narrow subpaths exist precisely so the startup
 * path can reach a helper without the barrel's dependencies.
 */
export function violationsIn(source, disallowed = DISALLOWED) {
  return [...externalRequires(source)]
    .filter((specifier) => Object.hasOwn(disallowed, specifier))
    .sort()
}

function main() {
  if (!existsSync(ENTRY)) {
    console.error(
      `\n[audit:maincoldpath] No build found: ${ENTRY}\n  Run \`npm run build\` first.\n`
    )
    process.exit(1)
  }

  const source = readFileSync(ENTRY, 'utf-8')
  const violations = violationsIn(source)

  if (violations.length > 0) {
    console.error(
      `\n[31m✗ [audit:maincoldpath] the startup artifact evaluates ${violations.length} disallowed dependency/ies:[0m`
    )
    for (const name of violations) {
      console.error(`\n  • ${name}\n    ${DISALLOWED[name]}`)
    }
    console.error(
      `\n  These are evaluated before the window can be created, which is what this` +
        `\n  check exists to prevent. Something reachable from \`src/main/index.ts\`` +
        `\n  imports one of them statically — move that module into` +
        `\n  \`loadDeferredHandlers()\`, or reach the helper you need through a` +
        `\n  narrow subpath.\n`
    )
    process.exit(1)
  }

  console.log(
    `[32m✓ [audit:maincoldpath] the startup artifact evaluates none of the ${Object.keys(DISALLOWED).length} disallowed dependencies[0m`
  )
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main()
}
