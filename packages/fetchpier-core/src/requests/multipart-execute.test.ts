import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { stageBinary } from './binary-store'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import type { HttpRequest, MultipartPart } from '@shared/types'

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
  const d = mkdtempSync(join(tmpdir(), 'fp-mp-exec-'))
  dirs.push(d)
  return d
}

describe('multipart body — end-to-end via execute()', () => {
  it('CA-03: encodes a text + file part and the server sees the wire-shaped body', async () => {
    const ws = newWorkspace()
    const src = join(ws, 'tiny.bin')
    await fs.writeFile(src, Buffer.from('0123456789', 'ascii'))
    const staged = await stageBinary(ws, src)

    const endpoint = await server.forPost('/upload').thenReply(200, 'ok')

    const parts: MultipartPart[] = [
      { kind: 'text', id: 'mp-0', name: 'description', value: 'hello' },
      {
        kind: 'file',
        id: 'mp-1',
        name: 'file',
        file: {
          ref: staged.ref,
          originalName: staged.originalName,
          sizeBytes: staged.sizeBytes,
          mimeType: staged.mimeType
        }
      }
    ]

    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/upload`,
      headers: {},
      bodyType: 'multipart-form',
      multipartParts: parts
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      workspacePath: ws
    })
    expect(result.error).toBeUndefined()
    expect(result.response?.status).toBe(200)

    const reqs = await endpoint.getSeenRequests()
    expect(reqs).toHaveLength(1)
    const ct = reqs[0].headers['content-type']
    expect(typeof ct).toBe('string')
    expect(ct).toMatch(/^multipart\/form-data; boundary=fetchpier-/)
    const boundary = (ct as string).split('boundary=')[1]

    const body = await reqs[0].body.getDecodedBuffer()
    expect(body).not.toBeUndefined()
    const text = body!.toString('utf8')

    expect(text).toContain(`--${boundary}`)
    expect(text).toContain('Content-Disposition: form-data; name="description"')
    expect(text).toContain('hello')
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="tiny.bin"')
    expect(text).toContain('Content-Type: application/octet-stream')
    expect(text).toContain('0123456789')
    expect(text).toMatch(new RegExp(`--${boundary}--\\r\\n$`))

    expect(result.request?.headers['Content-Type']).toBe(ct)
    expect(result.request?.multipartParts).toHaveLength(2)
  })

  it('CA-04: interpolates {{vars}} in text values but never in file.ref', async () => {
    const ws = newWorkspace()
    const src = join(ws, 'a.jpg')
    await fs.writeFile(src, Buffer.from('JPG'))
    const staged = await stageBinary(ws, src)

    const endpoint = await server.forPost('/x').thenReply(200, 'ok')

    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/x`,
      headers: {},
      bodyType: 'multipart-form',
      variables: { userId: 'u123' },
      multipartParts: [
        { kind: 'text', id: 'mp-0', name: 'metadata', value: 'id={{userId}}' },
        {
          kind: 'file',
          id: 'mp-1',
          name: 'photo',
          file: {
            ref: staged.ref,
            originalName: staged.originalName,
            sizeBytes: staged.sizeBytes,
            mimeType: staged.mimeType
          }
        }
      ]
    }
    await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      workspacePath: ws
    })
    const reqs = await endpoint.getSeenRequests()
    const text = (await reqs[0].body.getDecodedBuffer())!.toString('utf8')
    expect(text).toContain('id=u123')
    // The filename on the wire is the original sanitized name; the {{userId}}
    // value never reached the file ref.
    expect(text).toContain(`filename="a.jpg"`)
  })

  it('lists a hand-typed lowercase content-type once in the snapshot, as sent (ENG-30)', async () => {
    const ws = newWorkspace()
    const endpoint = await server.forPost('/ct').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/ct`,
      headers: { 'content-type': 'multipart/form-data' },
      headerList: [{ name: 'content-type', value: 'multipart/form-data' }],
      bodyType: 'multipart-form',
      multipartParts: [{ kind: 'text', id: 'mp-0', name: 'a', value: 'b' }]
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      workspacePath: ws
    })
    expect(result.error).toBeUndefined()
    const sent = (await endpoint.getSeenRequests())[0].headers['content-type']
    expect(sent).toMatch(/boundary=/)
    const cts = Object.entries(result.request!.headers).filter(
      ([k]) => k.toLowerCase() === 'content-type'
    )
    expect(cts).toEqual([['Content-Type', sent]])
  })

  it('CA-12: skips disabled parts when encoding for the wire', async () => {
    const ws = newWorkspace()
    const endpoint = await server.forPost('/y').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/y`,
      headers: {},
      bodyType: 'multipart-form',
      multipartParts: [
        { kind: 'text', id: 'mp-0', name: 'keep', value: 'A' },
        { kind: 'text', id: 'mp-1', name: 'skip', value: 'B', disabled: true }
      ]
    }
    await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      workspacePath: ws
    })
    const text = (await (await endpoint.getSeenRequests())[0].body.getDecodedBuffer())!.toString(
      'utf8'
    )
    expect(text).toContain('name="keep"')
    expect(text).not.toContain('name="skip"')
  })

  it('returns MULTIPART_FILE_MISSING-ish error when the staged file is gone', async () => {
    const ws = newWorkspace()
    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/z`,
      headers: {},
      bodyType: 'multipart-form',
      multipartParts: [
        {
          kind: 'file',
          id: 'mp-0',
          name: 'doc',
          file: {
            ref: 'c'.repeat(64) + '__nope.bin',
            originalName: 'nope.bin',
            sizeBytes: 0,
            mimeType: 'application/octet-stream'
          }
        }
      ]
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      workspacePath: ws
    })
    expect(result.response).toBeUndefined()
    expect(result.error).toMatch(/missing file|MULTIPART_FILE_MISSING/)
  })

  it('errors clearly when bodyType=multipart-form but no workspacePath is supplied', async () => {
    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/u`,
      headers: {},
      bodyType: 'multipart-form',
      multipartParts: [{ kind: 'text', id: 'mp-0', name: 'a', value: 'b' }]
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS
    })
    expect(result.error).toMatch(/workspacePath/i)
  })
})
