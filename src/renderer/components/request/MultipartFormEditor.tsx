import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Plus } from 'lucide-react'
import { Button } from '../ui/button'
import { applyOrder } from '../ui/sortable-context'
import { KvTable } from './KvTable'
import { MultipartPartRow } from './MultipartPartRow'
import type { MultipartFilePart, MultipartPart, MultipartTextPart } from '../../../shared/types'

interface MultipartFormEditorProps {
  parts: MultipartPart[]
  workspacePath: string | null
  onChange: (parts: MultipartPart[]) => void
  readOnly?: boolean
}

let partIdCounter = 0
function nextPartId(prefix: string): string {
  partIdCounter += 1
  return `mp-${prefix}-${Date.now().toString(36)}-${partIdCounter}`
}

export function MultipartFormEditor({
  parts,
  workspacePath,
  onChange,
  readOnly = false
}: MultipartFormEditorProps): React.JSX.Element {
  const { t } = useTranslation()

  const addTextPart = useCallback(() => {
    const next: MultipartTextPart = {
      kind: 'text',
      id: nextPartId('t'),
      name: '',
      value: ''
    }
    onChange([...parts, next])
  }, [parts, onChange])

  const addFilePart = useCallback(() => {
    const next: MultipartFilePart = {
      kind: 'file',
      id: nextPartId('f'),
      name: '',
      file: { ref: '', originalName: '', sizeBytes: 0, mimeType: '' }
    }
    onChange([...parts, next])
  }, [parts, onChange])

  const updatePart = useCallback(
    (id: string, next: MultipartPart) => {
      onChange(parts.map((p) => (p.id === id ? next : p)))
    },
    [parts, onChange]
  )

  const removePart = useCallback(
    (id: string) => {
      onChange(parts.filter((p) => p.id !== id))
    },
    [parts, onChange]
  )

  if (parts.length === 0) {
    return (
      <div className="flex h-full flex-col gap-3 p-3">
        <p className="text-[11px] text-muted-foreground">
          {t('request.body.multipart.headerHidden')}
        </p>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
          <p>{t('request.body.multipart.noPartsYet')}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addTextPart}
              disabled={readOnly}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('request.body.multipart.addTextPart')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addFilePart}
              disabled={readOnly || !workspacePath}
            >
              <FileUp className="mr-1.5 h-3.5 w-3.5" />
              {t('request.body.multipart.addFilePart')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <p className="px-3 pb-2 pt-3 text-[11px] text-muted-foreground">
        {t('request.body.multipart.headerHidden')}
      </p>
      <KvTable
        readOnly={readOnly}
        onReorder={readOnly ? undefined : (ids) => onChange(applyOrder(parts, ids, (p) => p.id))}
        footer={
          !readOnly && (
            <div className="flex gap-2 px-3 py-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addTextPart}
                disabled={readOnly}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {t('request.body.multipart.addTextPart')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addFilePart}
                disabled={readOnly || !workspacePath}
              >
                <FileUp className="mr-1.5 h-3.5 w-3.5" />
                {t('request.body.multipart.addFilePart')}
              </Button>
            </div>
          )
        }
        rows={parts.map((part) => ({
          id: part.id,
          node: (
            <MultipartPartRow
              part={part}
              workspacePath={workspacePath}
              onChange={(next) => updatePart(part.id, next)}
              onRemove={() => removePart(part.id)}
              readOnly={readOnly}
            />
          )
        }))}
      />
    </div>
  )
}
