// Per-phase lazy LanguageService wrapping a TypeScript VFS tailored for
// Fetchpier pre-request / post-response scripts (REQ-41 + REQ-42).
//
// The VFS mounts:
//   1. `lib.es2022.*.d.ts` (and transitive deps) from the bundled `typescript`
//      package — so the editor knows about `Array`, `Object`, `Map`, etc.
//   2. NO `lib.dom.d.ts` / `lib.webworker.d.ts` / node types → forbidden
//      globals (`setTimeout`, `process`, `require`, `Buffer`, …) surface as
//      "Cannot find name" diagnostics, mirroring the REQ-30 runtime contract.
//   3. `/fp.base.d.ts` — shared interfaces (source of truth in
//      `src/main/scripting/fp-api.d.ts`, emitted by
//      `scripts/generate-fp-dts.mjs`).
//   4. `/fp.preRequest.d.ts` *or* `/fp.postResponse.d.ts` — phase-scoped
//      `declare const fp: …` with the narrowed shape for that phase.
//   5. `/fp-globals.d.ts` — ambient `console` declaration.
//   6. `/script.ts` — a placeholder file, updated on every keystroke by the
//      CodeMirror `tsSync` extension.
//
// Two independent `LanguageService` instances (one per phase) are cached in a
// `Map<Phase, Promise<TsBundle>>`. They do NOT share a VFS because mounting
// both phase `.d.ts` files would cause a duplicate `fp` declaration.
//
// The whole bundle (`typescript` + `@typescript/vfs` + `@valtown/codemirror-ts`
// + lib contents) is loaded via dynamic `import()` the first time
// `getTsEnvironmentFor()` is called for a given phase, so it is split into its
// own chunk and does not bloat the initial renderer bundle.

import type * as tsType from 'typescript'
import type { VirtualTypeScriptEnvironment } from '@typescript/vfs'

/** The two scripting phases the editor supports. */
export type ScriptPhase = 'preRequest' | 'postResponse'

/** Path inside the VFS where the user script lives. */
export const SCRIPT_PATH = '/script.ts'

/** Path inside the VFS where the shared Fetchpier interfaces are mounted. */
export const FP_BASE_DTS_PATH = '/fp.base.d.ts'

/** Path inside the VFS where the phase-specific Fetchpier declaration is mounted. */
export const FP_PHASE_DTS_PATH = '/fp.phase.d.ts'

/** Path inside the VFS for the hand-written ambient globals exposed by the sandbox. */
const FP_GLOBALS_PATH = '/fp-globals.d.ts'

/**
 * Ambient globals the Fetchpier sandbox exposes *in addition to* the `fp` object.
 *
 * Kept as a string constant (not a separate `.d.ts` file) because declaring
 * ambient values like `console` in a file that sits under `src/renderer/**`
 * would leak into the renderer's own TypeScript program and conflict with
 * `lib.dom`. Mounting only in the VFS keeps the declaration scoped to the
 * script editor.
 *
 * Keep in sync with `consoleAlias` / `ALLOWED_GLOBALS` in
 * `src/main/scripting/fp-sandbox.ts`.
 */
const FP_GLOBALS_DTS = `// Ambient globals available inside Fetchpier scripts, in addition to the ES2022
// built-ins and the \`fp\` object.

/**
 * The scripts console. Each call writes a log entry visible in the Tests tab.
 * Aliased to \`fp.log\` / \`fp.warn\` / \`fp.error\` by the sandbox.
 */
declare const console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  info(...args: unknown[]): void
}
`

/**
 * Lazily-loaded bundle of the modules we only need when the Scripts tab is
 * opened. One instance per phase.
 */
interface TsBundle {
  ts: typeof tsType
  vfs: typeof import('@typescript/vfs')
  env: VirtualTypeScriptEnvironment
}

const bundleByPhase = new Map<ScriptPhase, Promise<TsBundle>>()

// Lazy-bundle TypeScript lib files as raw strings. Vite turns each key into a
// loader function; we only download the ones `knownLibFilesForCompilerOptions`
// reports as needed for our `lib: ['es2022']` setup (~25 files).
//
// We narrow the glob to only the es*, decorators and scripthost libs — `lib.dom.*`
// and `lib.webworker.*` are excluded so their large declarations (browser
// APIs like `window`, `document`, `fetch`, `setTimeout`, …) never land in the
// packaged bundle. Scripts accessing those globals will see "Cannot find name"
// diagnostics, matching the REQ-30 sandbox contract.
const LIB_LOADERS = import.meta.glob(
  [
    '../../../node_modules/typescript/lib/lib.es*.d.ts',
    '../../../node_modules/typescript/lib/lib.decorators*.d.ts',
    '../../../node_modules/typescript/lib/lib.scripthost.d.ts'
  ],
  { query: '?raw', import: 'default' }
) as Record<string, () => Promise<string>>

function libFilenameFromPath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

async function loadFpBaseDts(): Promise<string> {
  const mod = (await import('./fp.base.d.ts.generated?raw')) as {
    default: string
  }
  return mod.default
}

async function loadFpPhaseDts(phase: ScriptPhase): Promise<string> {
  if (phase === 'preRequest') {
    const mod = (await import('./fp.preRequest.d.ts.generated?raw')) as {
      default: string
    }
    return mod.default
  }
  const mod = (await import('./fp.postResponse.d.ts.generated?raw')) as {
    default: string
  }
  return mod.default
}

async function build(phase: ScriptPhase): Promise<TsBundle> {
  const [ts, vfs, fpBaseDts, fpPhaseDts] = await Promise.all([
    import('typescript'),
    import('@typescript/vfs'),
    loadFpBaseDts(),
    loadFpPhaseDts(phase)
  ])

  const compilerOptions: tsType.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['es2022'],
    strict: true,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    isolatedModules: false,
    skipLibCheck: true
  }

  const neededLibs = new Set<string>(vfs.knownLibFilesForCompilerOptions(compilerOptions, ts))

  const files = new Map<string, string>()
  const libLoadPromises: Promise<void>[] = []
  for (const [path, loader] of Object.entries(LIB_LOADERS)) {
    const filename = libFilenameFromPath(path)
    if (!neededLibs.has(filename)) continue
    libLoadPromises.push(
      loader().then((content) => {
        files.set(`/${filename}`, content)
      })
    )
  }
  await Promise.all(libLoadPromises)

  files.set(FP_BASE_DTS_PATH, fpBaseDts)
  files.set(FP_PHASE_DTS_PATH, fpPhaseDts)
  files.set(FP_GLOBALS_PATH, FP_GLOBALS_DTS)
  files.set(SCRIPT_PATH, ' ')

  const sys = vfs.createSystem(files)
  const env = vfs.createVirtualTypeScriptEnvironment(
    sys,
    [FP_BASE_DTS_PATH, FP_PHASE_DTS_PATH, FP_GLOBALS_PATH, SCRIPT_PATH],
    ts,
    compilerOptions
  )

  return { ts, vfs, env }
}

/**
 * Returns the TS virtual environment for the given phase, initialising it on
 * first call. Each phase gets an independent `LanguageService` because the
 * `fp` global is declared differently in each.
 *
 * The returned Promise resolves once typescript + vfs + fp types have been
 * loaded and the LanguageService is ready.
 */
export function getTsEnvironmentFor(phase: ScriptPhase): Promise<TsBundle> {
  let existing = bundleByPhase.get(phase)
  if (!existing) {
    existing = build(phase).catch((err) => {
      // Reset so a transient failure (e.g. chunk load) can be retried.
      bundleByPhase.delete(phase)
      throw err
    })
    bundleByPhase.set(phase, existing)
  }
  return existing
}

/**
 * Test-only helper to reset the per-phase cache between runs. Not exported in
 * the public barrel; keeping it here lets the vitest suite avoid cross-test
 * state.
 */
export function __resetTsEnvironmentForTests(): void {
  bundleByPhase.clear()
}
