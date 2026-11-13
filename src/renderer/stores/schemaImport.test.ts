import { describe, it, expect, beforeEach } from 'vitest'
import { activeSourceContent, useSchemaImportStore } from './schemaImport'

const s = (): ReturnType<typeof useSchemaImportStore.getState> => useSchemaImportStore.getState()

describe('schemaImport store — each source tab keeps its own content (IMP-27)', () => {
  beforeEach(() => {
    s().open({ targetFolder: '/ws/requests', targetLabel: 'requests' })
  })

  it('a file and pasted text are kept apart; the active tab picks which one counts', () => {
    s().setFileContent('openapi.yaml', 'FILE')
    s().setTextValue('TEXT')
    expect(activeSourceContent({ ...s(), sourceKind: 'file' })).toBe('FILE')
    expect(activeSourceContent({ ...s(), sourceKind: 'text' })).toBe('TEXT')
    expect(activeSourceContent({ ...s(), sourceKind: 'url' })).toBe('')
    expect(s().fileName).toBe('openapi.yaml')
  })

  it('switching tabs changes neither content', () => {
    s().setFileContent('a.json', 'FILE')
    s().setSourceKind('text')
    s().setTextValue('TEXT')
    s().setSourceKind('file')
    expect(s().fileContent).toBe('FILE')
    expect(s().textValue).toBe('TEXT')
  })

  it('opening the modal again clears both', () => {
    s().setFileContent('a.json', 'FILE')
    s().setTextValue('TEXT')
    s().open({ targetFolder: '/ws/requests', targetLabel: 'requests' })
    expect(s().fileName).toBeNull()
    expect(activeSourceContent({ ...s(), sourceKind: 'file' })).toBe('')
    expect(activeSourceContent({ ...s(), sourceKind: 'text' })).toBe('')
  })
})
