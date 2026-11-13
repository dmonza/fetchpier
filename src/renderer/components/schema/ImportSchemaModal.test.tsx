import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SchemaFormat, SchemaImportRequest } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, o?: Record<string, unknown>) => string } => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)
  })
}))
vi.mock('../../stores/environment', () => ({
  useEnvironmentStore: { getState: () => ({ environments: [], loadEnvironments: async () => {} }) }
}))
vi.mock('../../stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: '/ws' }) }
}))

import { ImportSchemaModal } from './ImportSchemaModal'
import { useSchemaImportStore } from '../../stores/schemaImport'

const OPENAPI = 'openapi: 3.0.0\npaths: {}'
const POSTMAN = '{"info":{"schema":"https://schema.getpostman.com/json/collection/v2.1.0/"}}'

let root: Root | null = null
let detectFormat: ReturnType<typeof vi.fn>
let importSchema: ReturnType<typeof vi.fn>

function detect(content: string): SchemaFormat | null {
  if (content === OPENAPI) return 'openapi'
  if (content === POSTMAN) return 'postman'
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function renderModal(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    useSchemaImportStore.getState().open({ targetFolder: '/ws/requests', targetLabel: 'requests' })
    root!.render(<ImportSchemaModal />)
  })
}

async function store(
  fn: (s: ReturnType<typeof useSchemaImportStore.getState>) => void
): Promise<void> {
  await act(async () => fn(useSchemaImportStore.getState()))
  await flush()
}

function importButton(): HTMLButtonElement {
  return [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('schemaImport.actions.import')
  ) as HTMLButtonElement
}

async function clickImport(): Promise<void> {
  await act(async () => {
    importButton().click()
  })
  await flush()
}

beforeEach(() => {
  detectFormat = vi.fn(async (c: string) => detect(c))
  importSchema = vi.fn(async () => ({
    collectionPath: '/ws/requests/x',
    operationsCreated: 1,
    foldersCreated: 1,
    warnings: [],
    detectedFormat: 'openapi',
    schemaTitle: 'x'
  }))
  vi.stubGlobal('api', {
    schema: { onProgress: () => () => {}, detectFormat, import: importSchema }
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('ImportSchemaModal — each tab keeps its own content (IMP-27)', () => {
  it('File tab imports the picked file after text was pasted in Paste text', async () => {
    await renderModal()
    await store((s) => s.setFileContent('openapi.yaml', OPENAPI))
    await store((s) => s.setSourceKind('text'))
    await store((s) => s.setTextValue(POSTMAN))
    expect(useSchemaImportStore.getState().detectedFormat).toBe('postman')
    await store((s) => s.setSourceKind('file'))
    // Detection follows the active tab back to the file.
    expect(useSchemaImportStore.getState().detectedFormat).toBe('openapi')
    await clickImport()
    const req = importSchema.mock.calls[0][0] as SchemaImportRequest
    expect(req.source).toEqual({ kind: 'text', value: OPENAPI })
    expect(req.postman).toBeUndefined()
  })

  it('File tab with no file picked cannot import text typed in Paste text', async () => {
    await renderModal()
    await store((s) => s.setSourceKind('text'))
    await store((s) => s.setTextValue(OPENAPI))
    expect(importButton().disabled).toBe(false)
    await store((s) => s.setSourceKind('file'))
    expect(useSchemaImportStore.getState().detectedFormat).toBeNull()
    expect(importButton().disabled).toBe(true)
  })

  it('URL tab drops a format detected from pasted text and sends no Postman options', async () => {
    await renderModal()
    await store((s) => s.setSourceKind('text'))
    await store((s) => s.setTextValue(POSTMAN))
    await store((s) => s.setSourceKind('url'))
    await store((s) => s.setUrlValue('https://example.com/openapi.yaml'))
    expect(useSchemaImportStore.getState().detectedFormat).toBeNull()
    await clickImport()
    const req = importSchema.mock.calls[0][0] as SchemaImportRequest
    expect(req.source).toEqual({ kind: 'url', value: 'https://example.com/openapi.yaml' })
    expect(req.postman).toBeUndefined()
  })

  it('Paste text tab imports the pasted text, not the picked file', async () => {
    await renderModal()
    await store((s) => s.setFileContent('openapi.yaml', OPENAPI))
    await store((s) => s.setSourceKind('text'))
    await store((s) => s.setTextValue(POSTMAN))
    await store((s) => s.setEnvironmentName('Env'))
    await clickImport()
    const req = importSchema.mock.calls[0][0] as SchemaImportRequest
    expect(req.source).toEqual({ kind: 'text', value: POSTMAN })
  })
})

describe('ImportSchemaModal — import failures are translated (IMP-28)', () => {
  it('shows the coded reason, not the IPC text or an absolute path', async () => {
    importSchema.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method \'schema:import\': Error: TARGET_EXISTS: collection folder "pets" already exists'
      )
    )
    await renderModal()
    await store((s) => s.setFileContent('openapi.yaml', OPENAPI))
    await clickImport()
    expect(useSchemaImportStore.getState().error).toBe(
      'schemaImport.errors.targetExists {"name":"pets"}'
    )
    expect(document.body.textContent).not.toContain('Error invoking remote method')
  })
})
