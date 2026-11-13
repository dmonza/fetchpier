import { create } from 'zustand'
import type { SchemaFormat, SchemaImportProgress, SchemaImportResult } from '../../shared/types'

export type ImportSourceKind = 'file' | 'url' | 'text'
export type EnvironmentStrategy = 'none' | 'new' | 'merge'

export interface SchemaImportOpenPayload {
  targetFolder: string
  targetLabel: string
  activeEnvId?: string | null
  activeEnvName?: string | null
}

interface SchemaImportState {
  isOpen: boolean
  targetFolder: string | null
  targetLabel: string | null

  sourceKind: ImportSourceKind
  fileName: string | null
  /** Text of the file picked in the File tab. Each tab keeps its own content. */
  fileContent: string
  urlValue: string
  textValue: string

  format: SchemaFormat | 'auto'
  detectedFormat: SchemaFormat | null

  collectionName: string
  conflictStrategy: 'merge' | 'abort'

  /** Postman-only: what to do with collection variables */
  environmentStrategy: EnvironmentStrategy
  environmentName: string
  /** Active env in the workspace when the modal was opened (needed for 'merge') */
  activeEnvId: string | null
  activeEnvName: string | null

  isImporting: boolean
  progress: SchemaImportProgress | null
  result: SchemaImportResult | null
  error: string | null

  open: (payload: SchemaImportOpenPayload) => void
  close: () => void
  setSourceKind: (kind: ImportSourceKind) => void
  setFileContent: (name: string, content: string) => void
  setUrlValue: (value: string) => void
  setTextValue: (value: string) => void
  setFormat: (format: SchemaFormat | 'auto') => void
  setDetectedFormat: (format: SchemaFormat | null) => void
  setCollectionName: (name: string) => void
  setConflictStrategy: (s: 'merge' | 'abort') => void
  setEnvironmentStrategy: (s: EnvironmentStrategy) => void
  setEnvironmentName: (name: string) => void
  setImporting: (b: boolean) => void
  setProgress: (p: SchemaImportProgress | null) => void
  setResult: (r: SchemaImportResult | null) => void
  setError: (e: string | null) => void
}

/**
 * The local content of the active tab — what format detection reads and what
 * *Import* sends: the picked file's text on File, the pasted text on Paste
 * text, nothing on URL (the main process fetches it).
 */
export function activeSourceContent(
  state: Pick<SchemaImportState, 'sourceKind' | 'fileContent' | 'textValue'>
): string {
  if (state.sourceKind === 'file') return state.fileContent
  if (state.sourceKind === 'text') return state.textValue
  return ''
}

export const useSchemaImportStore = create<SchemaImportState>((set) => ({
  isOpen: false,
  targetFolder: null,
  targetLabel: null,

  sourceKind: 'file',
  fileName: null,
  fileContent: '',
  urlValue: '',
  textValue: '',

  format: 'auto',
  detectedFormat: null,

  collectionName: '',
  conflictStrategy: 'abort',

  environmentStrategy: 'new',
  environmentName: '',
  activeEnvId: null,
  activeEnvName: null,

  isImporting: false,
  progress: null,
  result: null,
  error: null,

  open: ({ targetFolder, targetLabel, activeEnvId, activeEnvName }) =>
    set({
      isOpen: true,
      targetFolder,
      targetLabel,
      sourceKind: 'file',
      fileName: null,
      fileContent: '',
      urlValue: '',
      textValue: '',
      format: 'auto',
      detectedFormat: null,
      collectionName: '',
      conflictStrategy: 'abort',
      environmentStrategy: 'new',
      environmentName: '',
      activeEnvId: activeEnvId ?? null,
      activeEnvName: activeEnvName ?? null,
      isImporting: false,
      progress: null,
      result: null,
      error: null
    }),
  close: () => set({ isOpen: false }),

  setSourceKind: (sourceKind) => set({ sourceKind }),
  setFileContent: (fileName, fileContent) => set({ fileName, fileContent }),
  setUrlValue: (urlValue) => set({ urlValue }),
  setTextValue: (textValue) => set({ textValue }),
  setFormat: (format) => set({ format }),
  setDetectedFormat: (detectedFormat) => set({ detectedFormat }),
  setCollectionName: (collectionName) => set({ collectionName }),
  setConflictStrategy: (conflictStrategy) => set({ conflictStrategy }),
  setEnvironmentStrategy: (environmentStrategy) => set({ environmentStrategy }),
  setEnvironmentName: (environmentName) => set({ environmentName }),
  setImporting: (isImporting) => set({ isImporting }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ result }),
  setError: (error) => set({ error })
}))
