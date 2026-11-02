#!/usr/bin/env node
/**
 * network-egress-bundle — REQ-0061 sub-invariant I3 enforcement.
 *
 * Fails the build if the renderer bundle (`out/renderer/**`) references any
 * REMOTE resource — a URL the browser would auto-load (Google Fonts, a CDN
 * script, a `<img src="https://…">`, a CSS `url(https://…)`, etc.). This is the
 * build-time net of the three-layer enforcement; the ESLint override is the
 * source-time net and `test/e2e/network-egress.spec.ts` is the runtime net.
 *
 * Why not a raw `grep https://`? The renderer bundle legitimately contains
 * remote URL *string literals* — i18n placeholders ("https://example.com/…"),
 * the SVG XML namespace (`http://www.w3.org/2000/svg`, an identifier, never
 * fetched), and externalized labels. Those are not egress. The browser only
 * auto-loads a URL when it sits in a *resource-loading position*: a markup
 * src/href, a CSS url()/@import, or a dynamic .src= / import() in JS. So we
 * match those sink patterns (including protocol-relative `//host`) rather than
 * bare URLs — high signal, zero false positives on the current bundle.
 *
 * Allowlist: `scripts/audit/network-egress-allowlist.json` (expected empty).
 * Run: `npm run audit:network` (requires `npm run build` first; wired as
 * `postbuild` so every build enforces it).
 *
 * Exit codes: 0 = clean, 1 = unallowed remote reference found, 2 = setup error.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'

const REPO_ROOT = process.cwd()
const RENDERER_DIR = resolve(REPO_ROOT, 'out', 'renderer')
const ALLOWLIST_FILE = resolve(REPO_ROOT, 'scripts', 'audit', 'network-egress-allowlist.json')

const SCAN_EXTS = new Set(['.html', '.css', '.js'])

// A remote URL in a loading position: optional scheme then `//host`. Captured as
// `(https?:)?//` so protocol-relative references are caught too. `data:`/`blob:`/
// local (`/foo`, `./foo`, `#frag`) never match because they lack the leading `//`.
const REMOTE = String.raw`(?:https?:)?\/\/[^"'\)\s>]+`

const SINK_PATTERNS = [
  // Markup attributes that load a resource (HTML and JS-emitted template markup).
  {
    label: 'markup src/href',
    re: new RegExp(
      String.raw`<\s*(?:img|script|link|iframe|source|audio|video|track|embed|object|use|image)\b[^>]*?\b(?:src|href|data|xlink:href)\s*=\s*["']?${REMOTE}`,
      'gi'
    )
  },
  // CSS url() referencing a remote resource (skips url(data:…), url(#…), url(/…)).
  { label: 'css url()', re: new RegExp(String.raw`url\(\s*["']?${REMOTE}`, 'gi') },
  // CSS @import of a remote stylesheet.
  { label: 'css @import', re: new RegExp(String.raw`@import\s+(?:url\(\s*)?["']?${REMOTE}`, 'gi') },
  // Dynamic resource injection in JS: element.src = "https://…" / import("https://…").
  {
    label: 'js .src/.href assignment',
    re: new RegExp(String.raw`\.(?:src|href)\s*=\s*["']${REMOTE}`, 'gi')
  },
  { label: 'js dynamic import()', re: new RegExp(String.raw`\bimport\(\s*["']${REMOTE}`, 'gi') }
]

function fail(code, msg) {
  process.stderr.write(`\n[audit:network] ${msg}\n`)
  process.exit(code)
}

function walk(dir) {
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (SCAN_EXTS.has(full.slice(full.lastIndexOf('.')).toLowerCase())) out.push(full)
  }
  return out
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return []
  try {
    const parsed = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'))
    return Array.isArray(parsed.allow) ? parsed.allow : []
  } catch (err) {
    fail(2, `allowlist unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A match is allowed when an allowlist entry's `file` matches the path and its
 * `pattern` substring appears in the matched text. */
function isAllowed(allowlist, relPath, matched) {
  const normRel = relPath.split(sep).join('/')
  return allowlist.some((e) => {
    const fileOk = !e.file || e.file === '*' || normRel.endsWith(e.file)
    const patOk = !e.pattern || matched.includes(e.pattern)
    return fileOk && patOk
  })
}

function main() {
  if (!existsSync(RENDERER_DIR)) {
    fail(2, `renderer bundle missing: ${RENDERER_DIR}\n  Run \`npm run build\` first.`)
  }
  const allowlist = loadAllowlist()
  const files = walk(RENDERER_DIR)

  /** @type {Array<{ file: string; line: number; sink: string; text: string }>} */
  const violations = []

  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const relPath = relative(REPO_ROOT, file)
    for (const { label, re } of SINK_PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(content)) !== null) {
        const matched = m[0]
        if (isAllowed(allowlist, relPath, matched)) continue
        const line = content.slice(0, m.index).split('\n').length
        violations.push({
          file: relPath,
          line,
          sink: label,
          text: matched.length > 120 ? matched.slice(0, 117) + '…' : matched
        })
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `\n\x1b[31m✗ [audit:network] ${violations.length} remote resource reference(s) in the renderer bundle (network egress invariant):\x1b[0m\n`
    )
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}  [${v.sink}]  ${v.text}\n`)
    }
    process.stderr.write(
      '\nThe renderer must reference only local/data resources. Move the resource into the\n' +
        'bundle, or — if there is a justified exception — add it to\n' +
        'scripts/audit/network-egress-allowlist.json with a written reason.\n'
    )
    process.exit(1)
  }

  process.stdout.write(
    `\x1b[32m✓ [audit:network] no remote resource references in ${files.length} renderer bundle file(s)\x1b[0m\n`
  )
}

main()
