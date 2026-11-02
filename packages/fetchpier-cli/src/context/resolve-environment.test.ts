import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveEnvironment } from './resolve-environment'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

/**
 * A legacy-shaped environment: folder and identifier are the same string. This is
 * what every workspace created before the identity split looks like on disk, and
 * it is what pins the "existing pipelines are unaffected" guarantee.
 */
function writeEnv(ws: string, folder: string, variables: Record<string, string>): void {
  writeEnvWithId(ws, folder, folder, variables)
}

/** An environment whose identifier is opaque and unrelated to its folder. */
function writeEnvWithId(
  ws: string,
  folder: string,
  id: string,
  variables: Record<string, string>
): void {
  const dir = join(ws, 'environments', folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ id, name: folder, variables }))
}

describe('resolveEnvironment', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'fp-env-'))
    mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  })
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  it('falls back to the default environment and returns its variables', async () => {
    writeEnv(ws, 'default', { baseUrl: 'http://localhost' })
    const resolved = await resolveEnvironment({ workspacePath: ws, env: {} })
    expect(resolved).toEqual({
      id: 'default',
      folder: 'default',
      variables: { baseUrl: 'http://localhost' }
    })
  })

  it('honors --env', async () => {
    writeEnv(ws, 'default', {})
    writeEnv(ws, 'staging', { baseUrl: 'https://staging' })
    const resolved = await resolveEnvironment({ flag: 'staging', workspacePath: ws, env: {} })
    expect(resolved.id).toBe('staging')
  })

  it('uses FETCHPIER_ENV when no flag', async () => {
    writeEnv(ws, 'staging', {})
    const resolved = await resolveEnvironment({
      workspacePath: ws,
      env: { FETCHPIER_ENV: 'staging' }
    })
    expect(resolved.id).toBe('staging')
  })

  it('flag wins over the env var', async () => {
    writeEnv(ws, 'dev', {})
    writeEnv(ws, 'staging', {})
    const resolved = await resolveEnvironment({
      flag: 'dev',
      workspacePath: ws,
      env: { FETCHPIER_ENV: 'staging' }
    })
    expect(resolved.id).toBe('dev')
  })

  it('exit 6 with source when --env is missing', async () => {
    writeEnv(ws, 'default', {})
    try {
      await resolveEnvironment({ flag: 'qa', workspacePath: ws, env: {} })
      expect.unreachable()
    } catch (err) {
      expect((err as CliError).exitCode).toBe(EXIT.ENVIRONMENT)
      expect((err as CliError).message).toContain('from --env')
      expect((err as CliError).hints?.join(' ') ?? '').toContain('default')
    }
  })

  it('exit 6 with a helpful message when no default exists and no source given', async () => {
    writeEnv(ws, 'staging', {})
    try {
      await resolveEnvironment({ workspacePath: ws, env: {} })
      expect.unreachable()
    } catch (err) {
      expect((err as CliError).exitCode).toBe(EXIT.ENVIRONMENT)
      expect((err as CliError).message).toContain("no 'default' environment")
      expect((err as CliError).hints?.join(' ') ?? '').toContain('FETCHPIER_ENV')
    }
  })

  // ── Selection is by folder name, not by identifier ────────────────────────

  it('selects by folder name when the identifier is opaque (CA-15)', async () => {
    writeEnvWithId(ws, 'staging', '9f1c-4a2e-opaque', { baseUrl: 'https://staging' })

    const resolved = await resolveEnvironment({ flag: 'staging', workspacePath: ws, env: {} })

    expect(resolved.variables).toEqual({ baseUrl: 'https://staging' })
    // The id it hands to core is still the opaque one — that is what addresses
    // the cookie jar and the local values.
    expect(resolved.id).toBe('9f1c-4a2e-opaque')
    expect(resolved.folder).toBe('staging')
  })

  it('does not accept an opaque identifier as a selector (CA-16)', async () => {
    writeEnvWithId(ws, 'staging', '9f1c-4a2e-opaque', {})
    try {
      await resolveEnvironment({ flag: '9f1c-4a2e-opaque', workspacePath: ws, env: {} })
      expect.unreachable()
    } catch (err) {
      expect((err as CliError).exitCode).toBe(EXIT.ENVIRONMENT)
      // The message lists the folder names — the strings --env accepts.
      expect((err as CliError).hints?.join(' ') ?? '').toContain('staging')
      expect((err as CliError).hints?.join(' ') ?? '').not.toContain('9f1c-4a2e-opaque')
    }
  })

  it('matches the folder name case-insensitively', async () => {
    writeEnvWithId(ws, 'staging', 'opaque', { a: '1' })
    const resolved = await resolveEnvironment({ flag: 'STAGING', workspacePath: ws, env: {} })
    expect(resolved.folder).toBe('staging')
  })

  it('resolves a pre-existing workspace exactly as before the identity split (CA-18)', async () => {
    // Folder and identifier are both `default`, as in every legacy workspace.
    writeEnv(ws, 'default', { baseUrl: 'http://localhost' })

    const resolved = await resolveEnvironment({ flag: 'default', workspacePath: ws, env: {} })

    expect(resolved.id).toBe('default')
    expect(resolved.folder).toBe('default')
    expect(resolved.variables).toEqual({ baseUrl: 'http://localhost' })
  })
})
