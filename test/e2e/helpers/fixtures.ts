import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Playwright always runs from the repo root, so `process.cwd()` is reliable
// here. Using it (rather than `import.meta.url` / `__dirname`) keeps the
// helpers compatible with whichever module mode Playwright's transformer
// picks at runtime.
const REPO_ROOT = process.cwd()
const FIXTURES_ROOT = resolve(REPO_ROOT, 'test', 'workspaces')

export type WorkspaceFixtureName =
  'default' | 'postman-import' | 'binary-tests' | 'body-modes' | 'instances'

export interface CopiedWorkspace {
  /** Absolute path of the temporary copy. */
  path: string
  /** Original fixture name (for logging). */
  source: WorkspaceFixtureName
  /** Resolved baseUrl baked into the environment file at copy time. */
  baseUrl: string | undefined
}

function envOverrideBaseUrl(): string | undefined {
  const raw = process.env.FETCHPIER_TEST_HTTPBIN_URL?.trim()
  return raw && raw.length > 0 ? raw : undefined
}

/**
 * Substitute the `baseUrl` in any `environments/*\/config.json` so the spec
 * can be pointed at a local httpbin instance via FETCHPIER_TEST_HTTPBIN_URL.
 * No-op when the env var is unset.
 */
async function applyBaseUrlOverride(workspaceDir: string): Promise<string | undefined> {
  const override = envOverrideBaseUrl()
  if (!override) {
    // No override: read the smoke env's baseUrl just for diagnostics.
    try {
      const defaultEnv = await fs.readFile(
        join(workspaceDir, 'environments', 'default', 'config.json'),
        'utf-8'
      )
      return JSON.parse(defaultEnv).variables?.baseUrl
    } catch {
      return undefined
    }
  }

  const envsRoot = join(workspaceDir, 'environments')
  let entries: string[]
  try {
    entries = await fs.readdir(envsRoot)
  } catch {
    return override
  }

  for (const entry of entries) {
    const cfgPath = join(envsRoot, entry, 'config.json')
    try {
      const raw = await fs.readFile(cfgPath, 'utf-8')
      const cfg = JSON.parse(raw) as { variables?: Record<string, string> }
      if (cfg.variables && typeof cfg.variables.baseUrl === 'string') {
        cfg.variables.baseUrl = override
        await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8')
      }
    } catch {
      // Skip unreadable entries — they're not our concern here.
    }
  }
  return override
}

/**
 * Copy a versioned fixture under `test/workspaces/<name>/` to a fresh tmpdir
 * and return the absolute destination path. The caller is responsible for
 * passing that path to `launchApp()` and for awaiting `closeApp()`, which
 * removes the tmpdir.
 */
export async function copyWorkspaceFixture(name: WorkspaceFixtureName): Promise<CopiedWorkspace> {
  const source = join(FIXTURES_ROOT, name)
  if (!existsSync(source)) {
    throw new Error(`Workspace fixture not found: ${source}`)
  }

  const dest = await fs.mkdtemp(join(tmpdir(), `fp-e2e-${name}-`))
  await fs.cp(source, dest, { recursive: true })
  const baseUrl = await applyBaseUrlOverride(dest)
  return { path: dest, source: name, baseUrl }
}

export async function removeWorkspaceFixture(copied: CopiedWorkspace): Promise<void> {
  await fs.rm(copied.path, { recursive: true, force: true })
}
