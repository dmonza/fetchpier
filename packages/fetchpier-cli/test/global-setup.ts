import { execSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { staleArtefacts } from './build-freshness'

/**
 * Build the CLI bundle once, before any worker of the `cli` Vitest project
 * starts.
 *
 * The integration and smoke specs launch the built artefacts in a child
 * process, so on a fresh clone (CI is always one) something has to build them.
 * Each spec used to do it itself, guarded by `existsSync`. That is wrong three
 * ways once Vitest runs the files in parallel workers:
 *
 * 1. All of them see the artefact missing at the same instant and each shells
 *    out to a full `build:core && build:cli`.
 * 2. `tsup` runs with `clean: !options.watch`, so every one-shot build empties
 *    `dist/` before writing — the concurrent builds wipe each other's output.
 * 3. A `beforeAll` gets Vitest's 10 s `hookTimeout`, and the build measures
 *    ~7 s on a fast developer machine. A CI runner has no margin at all.
 *
 * Between them those produced two different red runs from one cause: a hook
 * timeout on windows-latest and a killed worker on macos-latest, while Linux
 * happened to win the race. `globalSetup` runs once, before the workers exist,
 * and is not bound by `hookTimeout` — all three failure modes disappear.
 *
 * **Presence is not freshness.** This used to build only when an artefact was
 * missing, which is right on a fresh clone and wrong everywhere else: a `dist/`
 * left behind by an earlier checkout satisfies an existence check while being a
 * bundle nobody is editing, so the whole project reports on the wrong code. CI
 * never sees it — a fresh clone has no `dist/` — so the failure is reserved for
 * developer machines, where it is silent in the passing direction too. It cost
 * one red run whose four failures all pointed at the wrong cause. The decision
 * itself lives in `build-freshness.ts`, where it is tested.
 */
const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')
const REPO_ROOT = resolve(here, '../../..')
const CORE_ROOT = resolve(REPO_ROOT, 'packages/fetchpier-core')

/**
 * All come out of the same build; the specs use one each. The license notices
 * count too: a `dist/` from before they existed has fresh bundles and no notices.
 */
const ARTEFACTS = [
  resolve(PACKAGE_ROOT, 'dist/fp.js'),
  resolve(PACKAGE_ROOT, 'dist/index.js'),
  resolve(PACKAGE_ROOT, 'dist/THIRD_PARTY_LICENSES.txt')
]

/**
 * Everything the build reads. Core's sources count because core is bundled
 * **into** these artefacts (`noExternal`) — watching only this package's own
 * sources would miss the case where a core edit is what made the bundle stale.
 */
function buildInputs(): string[] {
  // `tooling/` holds the build plugins `tsup.config.ts` imports.
  const roots = [join(PACKAGE_ROOT, 'src'), join(PACKAGE_ROOT, 'tooling'), join(CORE_ROOT, 'src')]
  const manifests = [PACKAGE_ROOT, CORE_ROOT].flatMap((root) => [
    join(root, 'package.json'),
    join(root, 'tsup.config.ts')
  ])

  return [...roots.flatMap(walk), ...manifests]
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

export default function setup(): void {
  const stale = staleArtefacts({ artefacts: ARTEFACTS, sources: buildInputs(), mtimeOf })
  if (stale.length === 0) return
  // Shell string on purpose: the `&&` needs one, and `npm` is a `.cmd` shim on
  // Windows that cannot be spawned without it. The command is a fixed literal —
  // nothing is interpolated, so there is no injection surface.
  execSync('npm run build:core && npm run build:cli', { cwd: REPO_ROOT, stdio: 'inherit' })
}
