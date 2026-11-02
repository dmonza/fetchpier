#!/usr/bin/env node
// @ts-check
/**
 * atomic-write-audit — "Atomic writes — closing the write-safety coverage gap"
 * regression guard.
 *
 * A prior requirement built a shared atomic-write helper (temp file + rename,
 * so an interruption never leaves a target truncated/partial) and claimed —
 * as a prose-only acceptance check — that every workspace content writer used
 * it. That claim was never mechanically verified and turned out to be false
 * for ten call sites. This script is the mechanical net that claim was
 * missing: it fails if any source file outside the helper's own module and an
 * explicit, reviewed allowlist calls `fs.writeFile`/`writeFileSync`/
 * `renameSync` directly (see below for why the async `fs.rename` is not
 * scanned).
 *
 * Scope: `src/main/**`, `src/preload/**`, `packages/fetchpier-core/src/**`,
 * `packages/fetchpier-cli/src/**` (`.ts`, excluding `*.test.ts`/`*.spec.ts`/
 * `*.d.ts`). `src/renderer`/`src/shared` are not scanned — the renderer never
 * imports `fs` (a separate, already-enforced architecture invariant).
 *
 * Deletions (`fs.unlink`/`fs.rm`), pure renames-as-moves that don't write new
 * content, and directory creation (`fs.mkdir`) are out of scope — the atomic
 * write contract (never leave a target truncated/partial) doesn't apply to
 * them. In particular, the async `fs.rename` is deliberately **not** scanned:
 * a rename-based atomic-write commit is always paired with a preceding
 * `writeFile`/`writeFileSync` call in the same non-compliant function (you
 * must write the temp file before renaming it into place), so that call alone
 * already catches every real duplicate-implementation case; scanning `rename`
 * itself would also flag this codebase's legitimate request/collection move
 * and rename operations (e.g. the request-tree's `tree.rename(...)`), which
 * are pure moves of an already-complete file, not partial-write risks.
 * `writeFile`/`writeFileSync`/`renameSync` are flagged whether qualified
 * (`fs.writeFile(`) or bare (`writeFile(`, e.g. `import { writeFile } from
 * 'fs/promises'`) — no false-positive collision exists for those three in
 * this codebase today (unlike bare `rename(`, which does collide as above).
 *
 * This is a regex/line scan over source text, not an AST parse — matching the
 * existing `audit:network`/`audit:coldpath` precedent. Trade-off: a literal
 * mention inside a comment or string is still flagged (see the guard's own
 * test for this documented limitation); the allowlist is the intended escape
 * hatch for a reviewed exception, not comment-awareness.
 *
 * Allowlist: `scripts/audit/atomic-write-allowlist.json`.
 * Run: `npm run audit:atomicwrites` — a source-level check, so (unlike
 * `audit:network`/`audit:coldpath`, which need `out/**`) it needs no build
 * first; wired as the first step of `scripts/post-req.mjs`.
 *
 * Exit codes: 0 = clean, 1 = unallowed direct write/rename found, 2 = setup error.
 */
import { promises as fsp, readFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = process.cwd()
const ALLOWLIST_FILE = resolve(REPO_ROOT, 'scripts', 'audit', 'atomic-write-allowlist.json')
const HELPER_MODULE = resolve(
  REPO_ROOT,
  'packages',
  'fetchpier-core',
  'src',
  'workspace',
  'atomic-write.ts'
)
const SCAN_ROOTS = [
  'src/main',
  'src/preload',
  'packages/fetchpier-core/src',
  'packages/fetchpier-cli/src'
]

const SINK_PATTERNS = [
  // Optional `fs.`/`fsp.` qualifier captured in the match so the reported text
  // reads naturally either way (`writeFile(` or `fs.writeFile(`). The async
  // `fs.rename` is deliberately not scanned — see the module doc comment.
  { label: 'writeFile', re: /\b(?:fs\.|fsp\.)?writeFile\(/g },
  { label: 'writeFileSync', re: /\b(?:fs\.|fsp\.)?writeFileSync\(/g },
  { label: 'renameSync', re: /\b(?:fs\.|fsp\.)?renameSync\(/g }
]

function fail(code, msg) {
  process.stderr.write(`\n[audit:atomicwrites] ${msg}\n`)
  process.exit(code)
}

/**
 * Scan one file's content for a direct write/rename call, outside the pattern
 * choice's known false-positive exclusions (see the module doc comment).
 *
 * @param {string} relPath repo-relative path, forward-slash separated (used only in the returned records)
 * @param {string} content
 * @returns {Array<{ file: string, line: number, match: string }>}
 */
export function scanFileForViolations(relPath, content) {
  /** @type {Array<{ file: string, line: number, match: string }>} */
  const violations = []
  for (const { re } of SINK_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length
      violations.push({ file: relPath, line, match: m[0] })
    }
  }
  violations.sort((a, b) => a.line - b.line)
  return violations
}

/**
 * @param {Array<{ file: string, reason: string }>} allowlist
 * @param {string} relPath repo-relative path, forward-slash separated
 * @returns {boolean}
 */
export function isAllowed(allowlist, relPath) {
  return allowlist.some((e) => relPath === e.file || relPath.startsWith(e.file))
}

/**
 * @param {string} filePath
 * @returns {Array<{ file: string, reason: string }>}
 */
export function loadAllowlist(filePath) {
  if (!existsSync(filePath)) return []
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed.allow) ? parsed.allow : []
  } catch (err) {
    fail(2, `allowlist unreadable: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

const SCANNABLE_EXT = '.ts'
const EXCLUDED_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts']

/**
 * Recursively collect every `.ts` source file under `roots` (repo-relative
 * directories), excluding test/spec/declaration files.
 *
 * @param {string} repoRoot
 * @param {string[]} roots
 * @returns {Promise<string[]>}
 */
export async function collectSourceFiles(repoRoot, roots) {
  /** @type {string[]} */
  const out = []
  async function walk(dir) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // root doesn't exist (e.g. a package not built yet) — nothing to scan
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.name.endsWith(SCANNABLE_EXT)) continue
      if (EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
      out.push(full)
    }
  }
  for (const root of roots) {
    await walk(resolve(repoRoot, root))
  }
  return out
}

/**
 * Run the full audit: collect scannable files under `roots`, skip the shared
 * helper's own module, skip allowlisted paths, and scan the rest.
 *
 * @param {{ repoRoot: string, roots: string[], helperModulePath: string, allowlist: Array<{ file: string, reason: string }> }} opts
 * @returns {Promise<{ ok: boolean, violations: Array<{ file: string, line: number, match: string }>, filesScanned: number }>}
 */
export async function auditAtomicWrites({ repoRoot, roots, helperModulePath, allowlist }) {
  const files = await collectSourceFiles(repoRoot, roots)
  const resolvedHelper = resolve(helperModulePath)

  /** @type {Array<{ file: string, line: number, match: string }>} */
  const violations = []
  let filesScanned = 0

  for (const file of files) {
    if (resolve(file) === resolvedHelper) continue
    const relPath = relative(repoRoot, file).split(sep).join('/')
    if (isAllowed(allowlist, relPath)) continue
    filesScanned += 1
    const content = await fsp.readFile(file, 'utf8')
    violations.push(...scanFileForViolations(relPath, content))
  }

  return { ok: violations.length === 0, violations, filesScanned }
}

async function main() {
  const allowlist = loadAllowlist(ALLOWLIST_FILE)
  const result = await auditAtomicWrites({
    repoRoot: REPO_ROOT,
    roots: SCAN_ROOTS,
    helperModulePath: HELPER_MODULE,
    allowlist
  })

  if (!result.ok) {
    process.stderr.write(
      `\n\x1b[31m✗ [audit:atomicwrites] ${result.violations.length} direct write/rename call(s) outside the shared atomic-write helper:\x1b[0m\n`
    )
    for (const v of result.violations) {
      process.stderr.write(`  ${v.file}:${v.line}  ${v.match}\n`)
    }
    process.stderr.write(
      '\nRoute this write through atomicWriteFile/atomicWriteFileSync/atomicWriteBatch\n' +
        '(packages/fetchpier-core/src/workspace/atomic-write.ts), or — if this is a\n' +
        'deliberate exception (a path the user named explicitly) — add it to\n' +
        'scripts/audit/atomic-write-allowlist.json with a reason.\n'
    )
    process.exit(1)
  }

  process.stdout.write(
    `\x1b[32m✓ [audit:atomicwrites] no direct write/rename outside the shared helper in ${result.filesScanned} file(s)\x1b[0m\n`
  )
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
