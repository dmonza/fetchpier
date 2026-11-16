import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ParsedHttpFile } from '../../shared/types'
import { useRequestStore } from '../stores/request'
import { needsRequestIdResolution, resolveTabRequestIds } from './resolve-tab-request-ids'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

const parsed = (requestId?: string): ParsedHttpFile => ({
  requests: [{ method: 'GET', url: 'https://x/', headers: {} }],
  variablesUsed: [],
  ...(requestId ? { requestId } : {})
})

function installParse(impl: (path: string) => Promise<ParsedHttpFile>): ReturnType<typeof vi.fn> {
  const parseFile = vi.fn(impl)
  ;(window as unknown as { api: unknown }).api = { request: { parseFile } }
  return parseFile
}

const tabs = () => useRequestStore.getState().tabs
const tabAt = (path: string) => tabs().find((t) => t.filePath === path)!

beforeEach(() => {
  useRequestStore.getState().restoreSession([], -1)
})

describe('resolveTabRequestIds (ISS-0081)', () => {
  it('restoring a session reads no file: restored tabs wait unresolved', () => {
    const parseFile = installParse(async () => parsed(ID_A))
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/a.http' }], 0)
    expect(parseFile).not.toHaveBeenCalled()
    expect(tabAt('/ws/requests/a.http').requestIdSource).toBeUndefined()
    expect(needsRequestIdResolution(tabAt('/ws/requests/a.http'))).toBe(true)
  })

  it("gives each restored tab its file's # @id, and keeps its own id when the file has none", async () => {
    installParse(async (p) => (p.endsWith('a.http') ? parsed(ID_A) : parsed()))
    useRequestStore
      .getState()
      .restoreSession([{ path: '/ws/requests/a.http' }, { path: '/ws/requests/noid.http' }], 0)
    const ownId = tabAt('/ws/requests/noid.http').requestId
    await resolveTabRequestIds()
    expect(tabAt('/ws/requests/a.http')).toMatchObject({ requestId: ID_A, requestIdSource: 'file' })
    expect(tabAt('/ws/requests/noid.http')).toMatchObject({
      requestId: ownId,
      requestIdSource: 'generated'
    })
  })

  it('resolves a tab whose file cannot be read as having no # @id', async () => {
    installParse(async () => {
      throw new Error('ENOENT')
    })
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/gone.http' }], 0)
    await resolveTabRequestIds()
    expect(tabAt('/ws/requests/gone.http').requestIdSource).toBe('generated')
  })

  it('does not overwrite a tab the editor loaded while the read was in flight', async () => {
    let release!: () => void
    installParse(() => new Promise((r) => (release = () => r(parsed(ID_A)))))
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/a.http' }], 0)
    const pending = resolveTabRequestIds()
    const id = tabAt('/ws/requests/a.http').id
    useRequestStore.getState().updateTab(id, { requestId: ID_B, requestIdSource: 'file' })
    release()
    await pending
    expect(tabAt('/ws/requests/a.http').requestId).toBe(ID_B)
  })

  it('reads the new path when the tab moved while the read was in flight', async () => {
    let releaseFirst!: () => void
    const parseFile = installParse((p) =>
      p.endsWith('old.http')
        ? new Promise((r) => (releaseFirst = () => r(parsed(ID_A))))
        : Promise.resolve(parsed(ID_B))
    )
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/old.http' }], 0)
    const pending = resolveTabRequestIds()
    useRequestStore
      .getState()
      .repointTabs([{ oldPath: '/ws/requests/old.http', newPath: '/ws/requests/new.http' }])
    releaseFirst()
    await pending
    expect(parseFile).toHaveBeenLastCalledWith('/ws/requests/new.http')
    expect(tabAt('/ws/requests/new.http')).toMatchObject({
      requestId: ID_B,
      requestIdSource: 'file'
    })
  })

  it('reads each tab once even when asked again while a read is in flight', async () => {
    let release!: () => void
    const parseFile = installParse(() => new Promise((r) => (release = () => r(parsed(ID_A)))))
    useRequestStore.getState().restoreSession([{ path: '/ws/requests/a.http' }], 0)
    const first = resolveTabRequestIds()
    const second = resolveTabRequestIds()
    release()
    await Promise.all([first, second])
    await resolveTabRequestIds()
    expect(parseFile).toHaveBeenCalledTimes(1)
  })

  it('leaves untitled, read-only and raw tabs alone', async () => {
    const parseFile = installParse(async () => parsed(ID_A))
    const { openTab } = useRequestStore.getState()
    openTab()
    openTab({ filePath: null, isReadOnly: true, historyEntryId: 'run-1' })
    openTab({ filePath: null, isReadOnly: true, historyEntryId: 'raw:run-1', rawContent: 'GET x' })
    expect(tabs().some(needsRequestIdResolution)).toBe(false)
    await resolveTabRequestIds()
    expect(parseFile).not.toHaveBeenCalled()
  })
})
