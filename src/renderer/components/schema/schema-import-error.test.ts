import { describe, it, expect } from 'vitest'
import { schemaImportErrorText } from './schema-import-error'

const t = (key: string, opts?: Record<string, unknown>): string =>
  opts ? `${key} ${JSON.stringify(opts)}` : key
const remote = (inner: string): Error =>
  new Error(`Error invoking remote method 'schema:import': Error: ${inner}`)

describe('schemaImportErrorText (IMP-28)', () => {
  it.each([
    [
      'TARGET_EXISTS: collection folder "pets" already exists',
      'schemaImport.errors.targetExists {"name":"pets"}'
    ],
    ['FETCH_FAILED: HTTP 404', 'schemaImport.errors.fetchFailed {"detail":"HTTP 404"}'],
    [
      'FORMAT_UNDETECTED: could not auto-detect the schema format',
      'schemaImport.errors.formatUndetected'
    ],
    [
      'PARSE_FAILED: Invalid Postman JSON: Unexpected end of JSON input',
      'schemaImport.errors.parseFailed {"detail":"Invalid Postman JSON: Unexpected end of JSON input"}'
    ],
    [
      'ENVIRONMENT_NAME_CONFLICT: folder "pets" is already used by environment "Pets"',
      'environment.errors.folderConflict {"name":"Pets"}'
    ],
    [
      'ENVIRONMENT_NAME_EMPTY: "!!" contains no letter or digit, so it maps to no folder name',
      'environment.errors.nameEmpty'
    ]
  ])('maps %s through IPC to its translated message', (inner, expected) => {
    expect(schemaImportErrorText(remote(inner), t)).toBe(expected)
  })

  it('an unknown failure keeps its detail without the IPC prefix or the error class', () => {
    expect(schemaImportErrorText(remote('No active workspace'), t)).toBe(
      'schemaImport.errors.importFailed {"message":"No active workspace"}'
    )
    expect(
      schemaImportErrorText(
        new Error("Error invoking remote method 'schema:import': TypeError: boom"),
        t
      )
    ).toBe('schemaImport.errors.importFailed {"message":"boom"}')
  })

  // A file-system failure from the writer or loader names its code only — never
  // the absolute workspace path, nor Node's English text (IMP-28 review).
  it.each([
    [
      "EACCES: permission denied, open 'C:\\Users\\me\\ws\\requests\\pets\\get-pets.http'",
      'EACCES'
    ],
    ['ENOSPC: no space left on device, write', 'ENOSPC'],
    ["EPERM: operation not permitted, mkdir '/home/me/ws/requests/pets'", 'EPERM']
  ])('a file-system failure (%s) shows its code without the path', (inner, code) => {
    const text = schemaImportErrorText(remote(inner), t)
    expect(text).toBe(`schemaImport.errors.writeFailed {"code":"${code}"}`)
    expect(text).not.toMatch(/Users|home|requests/)
  })

  it('accepts a non-Error rejection', () => {
    expect(schemaImportErrorText('FETCH_FAILED: HTTP 500', t)).toBe(
      'schemaImport.errors.fetchFailed {"detail":"HTTP 500"}'
    )
  })
})
