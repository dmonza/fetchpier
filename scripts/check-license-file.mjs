// @ts-check
/**
 * Drift gate for the generated third-party license file.
 *
 * `THIRD_PARTY_LICENSES.txt` is regenerated on every build (`prebuild` →
 * `generate:licenses`) but was never compared against the committed copy, so it
 * could go stale indefinitely with no signal — a legal artifact of a published
 * repository. This mirrors the drift check that already guards the generated
 * editor type declarations (`generate-fp-dts.mjs --check`).
 *
 * ORDERING: this must run BEFORE anything that builds. `npm run build` triggers
 * `generate:licenses`, which overwrites the committed file — run the check
 * afterwards and it would always compare against a freshly generated copy and
 * never fail.
 *
 * The pure parts (`normalize`, `compareLicenseText`, `checkLicenseFile`) are
 * exported for the tests; `main()` runs only on direct invocation.
 */

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const COMMITTED = join(REPO_ROOT, 'THIRD_PARTY_LICENSES.txt')
const REGENERATE_HINT = 'npm run generate:licenses'

/**
 * Compare-ready form: line endings unified and trailing blank lines dropped.
 *
 * Normalizing line endings is not cosmetic. The committed file is generated on
 * the maintainer's machine (CRLF) while the gate runs on Linux (LF); without
 * this, every run would report drift that does not exist.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function normalize(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/**
 * @param {string} committed
 * @param {string} generated
 * @returns {{ ok: boolean, firstDiffLine: number | null, committedLines: number, generatedLines: number }}
 */
export function compareLicenseText(committed, generated) {
  const a = normalize(committed)
  const b = normalize(generated)
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i += 1) {
    if (a[i] !== b[i]) {
      return {
        ok: false,
        firstDiffLine: i + 1,
        committedLines: a.length,
        generatedLines: b.length
      }
    }
  }
  return { ok: true, firstDiffLine: null, committedLines: a.length, generatedLines: b.length }
}

/**
 * @typedef {{ ok: boolean, reason?: 'drift' | 'missing' | 'generator-failed', detail?: string,
 *             firstDiffLine?: number | null }} LicenseCheckResult
 */

/**
 * Compare the committed license file against freshly generated content.
 * Both I/O collaborators are injected so this stays testable without invoking
 * the real generator.
 *
 * @param {{ readCommitted: () => Promise<string>, generate: () => Promise<string> }} deps
 * @returns {Promise<LicenseCheckResult>}
 */
export async function checkLicenseFile({ readCommitted, generate }) {
  let committed
  try {
    committed = await readCommitted()
  } catch (err) {
    return {
      ok: false,
      reason: 'missing',
      detail: err instanceof Error ? err.message : String(err)
    }
  }

  let generated
  try {
    generated = await generate()
  } catch (err) {
    return {
      ok: false,
      reason: 'generator-failed',
      detail: err instanceof Error ? err.message : String(err)
    }
  }

  const diff = compareLicenseText(committed, generated)
  if (diff.ok) return { ok: true }
  return { ok: false, reason: 'drift', firstDiffLine: diff.firstDiffLine }
}

/** Generate into a scratch file and read it back, leaving the committed copy untouched. */
async function generateToTemp() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fp-licenses-'))
  const out = join(dir, 'THIRD_PARTY_LICENSES.txt')
  // Invoke the generator's JS entry with the current Node binary rather than its
  // shim. Spawning a `.cmd` shim without a shell fails with EINVAL on Windows
  // (Node's CVE-2024-27980 mitigation), and using a shell would mean quoting a
  // temp path. This avoids both.
  const bin = join(
    REPO_ROOT,
    'node_modules',
    'generate-license-file',
    'bin',
    'generate-license-file'
  )
  try {
    execFileSync(
      process.execPath,
      [bin, '--input', './package.json', '--output', out, '--overwrite'],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }
    )
    return await fs.readFile(out, 'utf-8')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function main() {
  const result = await checkLicenseFile({
    readCommitted: () => fs.readFile(COMMITTED, 'utf-8'),
    generate: generateToTemp
  })

  if (result.ok) {
    console.log(
      '[check:licenses] OK — THIRD_PARTY_LICENSES.txt matches the current dependency set.'
    )
    return
  }

  if (result.reason === 'missing') {
    console.error(`[check:licenses] THIRD_PARTY_LICENSES.txt is missing (${result.detail}).`)
  } else if (result.reason === 'generator-failed') {
    console.error(`[check:licenses] could not generate the license file: ${result.detail}`)
  } else {
    console.error(
      `[check:licenses] THIRD_PARTY_LICENSES.txt is stale — first difference at line ${result.firstDiffLine}.`
    )
  }
  console.error(`Regenerate it with \`${REGENERATE_HINT}\` and commit the result.`)
  process.exit(1)
}

// Run only on direct invocation (not when imported by the tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
