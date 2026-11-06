import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { CACertEntry, ClientCertEntry, TlsScopeSettings } from '@shared/types'
import type { tls } from '@fetchpier/core'
import { describeError } from '@fetchpier/core'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

export interface ResolveTlsConfigInput {
  /** `--tls-config <file>`. */
  flag?: string
  /** `process.env` — read for `FETCHPIER_TLS_CONFIG`. */
  env?: NodeJS.ProcessEnv
  /** Directory a relative path resolves against. */
  cwd: string
}

/**
 * Resolve the TLS material given for this run (security finding P1-1): client
 * certificates and CAs that belong to the machine or the pipeline, not to the
 * workspace. Precedence: `--tls-config` > `FETCHPIER_TLS_CONFIG`; the value is a
 * path to a JSON file in the format of the workspace's `tls` block, whose files
 * sit next to it (filename-only, like `.fetchpier/certs/`). Nothing is copied or
 * persisted.
 *
 * Read and validated up front so a bad file stops the run before anything is
 * sent. The file may hold a literal passphrase, so an error names the source and
 * the path — never the content, not even the parser's message, which quotes the
 * text around the mistake.
 *
 * @throws CliError (usage) when the file cannot be read or is not a valid `tls` block.
 */
export async function resolveTlsConfig(
  input: ResolveTlsConfigInput
): Promise<tls.RunTlsMaterial | undefined> {
  const fromEnv = (input.env ?? process.env).FETCHPIER_TLS_CONFIG?.trim()
  const raw = input.flag ?? (fromEnv ? fromEnv : undefined)
  if (raw === undefined) return undefined
  const source = input.flag !== undefined ? '--tls-config' : 'FETCHPIER_TLS_CONFIG'
  const path = resolve(input.cwd, raw)
  const fail = (reason: string): never => {
    throw new CliError(EXIT.USAGE, `${source}: ${path}: ${reason}`)
  }

  let text: string
  try {
    text = await fs.readFile(path, 'utf-8')
  } catch (err) {
    return fail(`the file could not be read (${describeError(err)})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('the file is not valid JSON')
  }
  if (!isRecord(parsed)) return fail('expected a JSON object with a TLS block')

  return {
    certsDir: dirname(path),
    settings: {
      clientCertificates: listOf(parsed, 'clientCertificates', fail).map((item, i) =>
        clientCertificate(item, i + 1, fail)
      ),
      caCertificates: listOf(parsed, 'caCertificates', fail).map((item, i) =>
        caCertificate(item, i + 1, fail)
      )
    } satisfies TlsScopeSettings
  }
}

type Fail = (reason: string) => never

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listOf(block: Record<string, unknown>, key: string, fail: Fail): unknown[] {
  const value = block[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) return fail(`"${key}" must be a list`)
  return value
}

/**
 * A certificate file is named, never located: it sits next to the JSON file,
 * exactly as a workspace certificate sits in `.fetchpier/certs/`.
 */
function fileName(value: unknown, what: string, fail: Fail): string {
  if (typeof value !== 'string' || value.trim() === '') return fail(`${what} is missing`)
  if (/[\\/]/.test(value) || value === '.' || value === '..') {
    return fail(`${what} must be a file name next to the configuration file, not a path`)
  }
  return value
}

function clientCertificate(item: unknown, n: number, fail: Fail): ClientCertEntry {
  const at = `client certificate ${n}`
  if (!isRecord(item)) return fail(`${at} must be an object`)
  if (typeof item.host !== 'string' || item.host.trim() === '')
    return fail(`${at}: host is missing`)
  if (item.type !== 'pem' && item.type !== 'pfx') return fail(`${at}: type must be "pem" or "pfx"`)
  const port = item.port ?? null
  if (
    port !== null &&
    (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)
  ) {
    return fail(`${at}: port must be a number from 1 to 65535, or null for any port`)
  }
  const passphrase = item.passphrase ?? null
  if (passphrase !== null && typeof passphrase !== 'string') {
    return fail(`${at}: passphrase must be text`)
  }
  if (item.disabled !== undefined && typeof item.disabled !== 'boolean') {
    return fail(`${at}: disabled must be true or false`)
  }
  const files =
    item.type === 'pem'
      ? {
          certFile: fileName(item.certFile, `${at}: certFile`, fail),
          keyFile: fileName(item.keyFile, `${at}: keyFile`, fail)
        }
      : { pfxFile: fileName(item.pfxFile, `${at}: pfxFile`, fail) }
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `run-client-${n}`,
    host: item.host,
    port: port as number | null,
    type: item.type,
    ...files,
    passphrase: passphrase as string | null,
    disabled: item.disabled === true
  }
}

function caCertificate(item: unknown, n: number, fail: Fail): CACertEntry {
  const at = `CA certificate ${n}`
  if (!isRecord(item)) return fail(`${at} must be an object`)
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `run-ca-${n}`,
    file: fileName(item.file, `${at}: file`, fail),
    ...(typeof item.label === 'string' ? { label: item.label } : {})
  }
}
