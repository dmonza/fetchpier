import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { stageBinary, resolveBinaryRef } from './binary-store'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { parseHttpFile } from './parser'
import { serializeRequest } from '@shared/lib/http-serializer'
import { DEFAULT_REQUEST_STATE } from '@shared/types'
import type { HttpRequest, RequestEditorState } from '@shared/types'

let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
})

afterAll(async () => {
  await server.stop()
})

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function newWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'fp-bin-'))
  dirs.push(d)
  return d
}

function state(overrides: Partial<RequestEditorState> = {}): RequestEditorState {
  return { ...DEFAULT_REQUEST_STATE, ...overrides }
}

describe('binary body — end-to-end (mockttp)', () => {
  it('sends a small text file body verbatim (bytes survive the wire)', async () => {
    const ws = newWorkspace()
    const src = join(ws, 'hello.txt')
    const original = Buffer.from('hello binary world', 'utf-8')
    await fs.writeFile(src, original)
    const staged = await stageBinary(ws, src)
    const buf = await fs.readFile(staged.absolutePath)

    const endpoint = await server.forPost('/upload').thenReply(200, 'ok')

    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/upload`,
      headers: { 'Content-Type': staged.mimeType },
      bodyType: 'binary',
      binaryFile: {
        ref: staged.ref,
        originalName: staged.originalName,
        sizeBytes: staged.sizeBytes,
        mimeType: staged.mimeType
      }
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      binaryBody: buf
    })
    expect(result.response?.status).toBe(200)

    const reqs = await endpoint.getSeenRequests()
    expect(reqs).toHaveLength(1)
    const received = await reqs[0].body.getDecodedBuffer()
    expect(received).not.toBeUndefined()
    expect(received!.equals(original)).toBe(true)
  })

  it('sends binary bytes (PNG-like) verbatim', async () => {
    const ws = newWorkspace()
    const src = join(ws, 'tiny.png')
    // 8-byte PNG signature + a fake IHDR
    const original = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe
    ])
    await fs.writeFile(src, original)
    const staged = await stageBinary(ws, src)
    const buf = await fs.readFile(staged.absolutePath)

    const endpoint = await server.forPost('/img').thenReply(200, 'ok')
    await execute(
      {
        method: 'POST',
        url: `${server.url}/img`,
        headers: { 'Content-Type': staged.mimeType },
        bodyType: 'binary',
        binaryFile: {
          ref: staged.ref,
          originalName: staged.originalName,
          sizeBytes: staged.sizeBytes,
          mimeType: staged.mimeType
        }
      },
      {
        environmentId: null,
        workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
        binaryBody: buf
      }
    )
    const reqs = await endpoint.getSeenRequests()
    const received = await reqs[0].body.getDecodedBuffer()
    expect(received!.equals(original)).toBe(true)
  })

  it('honors an explicit Content-Type header (does not override with derived mime)', async () => {
    const ws = newWorkspace()
    const src = join(ws, 'data.json')
    await fs.writeFile(src, '{"a":1}')
    const staged = await stageBinary(ws, src)
    const buf = await fs.readFile(staged.absolutePath)

    const endpoint = await server.forPost('/explicit').thenReply(200, 'ok')
    await execute(
      {
        method: 'POST',
        url: `${server.url}/explicit`,
        // User chose an explicit Content-Type: it must NOT be replaced with `application/json` (the derived one).
        headers: { 'Content-Type': 'application/octet-stream' },
        bodyType: 'binary',
        binaryFile: {
          ref: staged.ref,
          originalName: staged.originalName,
          sizeBytes: staged.sizeBytes,
          mimeType: staged.mimeType
        }
      },
      {
        environmentId: null,
        workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
        binaryBody: buf
      }
    )
    const reqs = await endpoint.getSeenRequests()
    expect(reqs[0].headers['content-type']).toBe('application/octet-stream')
  })

  it('round-trips a `.http` file through parse → serialize without losing the binary marker', async () => {
    const ws = newWorkspace()
    const src = join(ws, 'pkg.zip')
    await fs.writeFile(src, Buffer.from('PK\u0003\u0004fake'))
    const staged = await stageBinary(ws, src)

    const originalState = state({
      method: 'POST',
      url: `${server.url}/upload`,
      bodyType: 'binary',
      binaryFile: {
        ref: staged.ref,
        originalName: staged.originalName,
        sizeBytes: staged.sizeBytes,
        mimeType: staged.mimeType
      }
    })
    const text = serializeRequest(originalState, '12345678-1234-1234-1234-123456789012')
    // On-disk .http contains the marker in the metadata region (before the
    // request line), and the request carries no body section.
    expect(text).toContain(`# @binary-file: ${staged.ref}`)
    const docLines = text.split('\n')
    const markerIdx = docLines.findIndex((l) => l.startsWith('# @binary-file:'))
    const reqIdx = docLines.findIndex((l) => /^[A-Z]+\s/.test(l))
    expect(markerIdx).toBeLessThan(reqIdx)
    // No blank-line-separated body after the headers (binary has no body).
    expect(docLines.slice(reqIdx + 1).every((l) => l.trim() === '' || l.includes(':'))).toBe(true)

    // requests/.files/ contains the staged file in <hash>__<name> format
    const filesDir = join(ws, 'requests', '.files')
    const entries = await fs.readdir(filesDir)
    expect(entries).toContain(staged.ref)

    // Parser turns the marker back into bodyType: 'binary' + binaryFile
    const parsed = parseHttpFile(text)
    expect(parsed.requests[0].bodyType).toBe('binary')
    expect(parsed.requests[0].binaryFile?.ref).toBe(staged.ref)
    expect(parsed.requests[0].body).toBeUndefined()
  })

  it('returns a clean "Binary file not found" error when the ref is dangling', async () => {
    const ws = newWorkspace()
    // Don't stage anything — just create the workspace layout
    await fs.mkdir(join(ws, 'requests', '.files'), { recursive: true })

    const fakeRef = 'a'.repeat(64) + '__missing.bin'

    // Simulate what the IPC handler does: try to read the file; ENOENT → return error
    let error: string | undefined
    try {
      await fs.readFile(resolveBinaryRef(ws, fakeRef))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') error = `Binary file not found: ${fakeRef}`
      else throw err
    }
    expect(error).toBe(`Binary file not found: ${fakeRef}`)
  })

  it('switching bodyType from binary to raw clears the staged reference on the serialized .http', () => {
    const withBinary = state({
      method: 'POST',
      url: 'https://example.com/x',
      bodyType: 'binary',
      binaryFile: {
        ref: 'a'.repeat(64) + '__foo.bin',
        originalName: 'foo.bin',
        sizeBytes: 1,
        mimeType: 'application/octet-stream'
      }
    })
    const withRaw: RequestEditorState = {
      ...withBinary,
      bodyType: 'raw',
      body: '{"x":1}',
      binaryFile: undefined
    }
    const text = serializeRequest(withRaw)
    expect(text).not.toContain('# @binary-file:')
    expect(text).toContain('{"x":1}')
  })
})
