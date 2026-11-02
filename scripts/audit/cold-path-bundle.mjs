#!/usr/bin/env node
/**
 * cold-path-bundle — enforces the "code-editor chunk off the renderer cold path"
 * invariant (PLAN-0121, requirement *Defer the code-editor chunk off the renderer
 * cold path*).
 *
 * Vite injects, into an entry's HTML, a `<script type="module">` for the entry
 * chunk plus a `<link rel="modulepreload">` for every STATIC transitive import of
 * that entry. Dynamic `import()` boundaries are loaded at runtime by the preload
 * helper and never appear in the HTML. Therefore:
 *
 *   - if the CodeMirror chunk is referenced by `out/renderer/index.html`, it is a
 *     static dependency of the renderer entry → it loads on the cold path → FAIL.
 *   - if it is absent from `index.html`, it is reached only across a dynamic
 *     import boundary → off the cold path → PASS.
 *
 * Only the main `index` entry is checked. The activity-panel popout entry
 * (`activity-panel-popout.html`) legitimately loads CodeMirror eagerly — the
 * popout's entire purpose is to show the editor-backed activity panel.
 *
 * Run: `npm run audit:coldpath` (requires `npm run build` first; wired as part of
 * `postbuild` so every build enforces it, alongside `audit:network`).
 *
 * Exit codes: 0 = clean, 1 = CodeMirror eagerly loaded by the entry, 2 = setup error.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = process.cwd()
const RENDERER_DIR = resolve(REPO_ROOT, 'out', 'renderer')
const INDEX_HTML = join(RENDERER_DIR, 'index.html')

// manualChunks key `codemirror` → emitted file `codemirror-<hash>.js`.
const CHUNK_FILE_RE = /^codemirror-[\w-]+\.js$/i
const CHUNK_REF_RE = /codemirror-[\w-]+\.js/i

function fail(code, msg) {
  process.stderr.write(`\n[audit:coldpath] ${msg}\n`)
  process.exit(code)
}

/** Locate the emitted CodeMirror chunk under out/renderer (and out/renderer/assets). */
function findCodemirrorChunk() {
  const assetsDir = join(RENDERER_DIR, 'assets')
  const dirs = [RENDERER_DIR, existsSync(assetsDir) ? assetsDir : null].filter(Boolean)
  for (const dir of dirs) {
    for (const entry of readdirSync(dir)) {
      if (CHUNK_FILE_RE.test(entry)) return entry
    }
  }
  return null
}

function main() {
  if (!existsSync(INDEX_HTML)) {
    fail(2, `renderer index.html missing: ${INDEX_HTML}\n  Run \`npm run build\` first.`)
  }

  const chunk = findCodemirrorChunk()
  if (!chunk) {
    fail(
      2,
      `no codemirror-*.js chunk found under ${RENDERER_DIR}.\n` +
        `  The manualChunks config may have changed; this audit can no longer verify the invariant.`
    )
  }

  const html = readFileSync(INDEX_HTML, 'utf8')
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
  const eager = refs.filter((r) => CHUNK_REF_RE.test(r))

  if (eager.length > 0) {
    fail(
      1,
      `\x1b[31m✗ the CodeMirror chunk is eagerly loaded by the renderer entry (index.html):\x1b[0m\n` +
        eager.map((r) => `    ${r}`).join('\n') +
        `\n\nindex.html must reach CodeMirror only across a dynamic import() boundary.\n` +
        `Some component on the AppLayout static graph imports the editor stack eagerly —\n` +
        `wrap that surface in React.lazy + <LazyBoundary/>.`
    )
  }

  process.stdout.write(
    `\x1b[32m✓ [audit:coldpath] CodeMirror chunk (${chunk}) is not eagerly loaded by index.html\x1b[0m\n`
  )
}

main()
