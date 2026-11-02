import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useCodeMirror } from '../../hooks/useCodeMirror'
import type { CodeMirrorLanguage } from '../../hooks/useCodeMirror'
import { KeyValueEditor } from './KeyValueEditor'
import { BinaryBodyPicker } from './BinaryBodyPicker'
import { MultipartFormEditor } from './MultipartFormEditor'
import type {
  BinaryFileAttachment,
  BodyType,
  KeyValuePair,
  MultipartPart,
  RawSubtype
} from '../../../shared/types'

const BODY_TYPES: BodyType[] = ['none', 'multipart-form', 'x-www-form-urlencoded', 'raw', 'binary']
const RAW_SUBTYPES: RawSubtype[] = ['json', 'xml', 'javascript', 'text', 'html']

const RAW_SUBTYPE_LANGUAGE: Record<RawSubtype, CodeMirrorLanguage> = {
  json: 'json',
  xml: 'xml',
  javascript: 'javascript',
  text: 'text',
  html: 'html'
}

interface BodyEditorProps {
  bodyType: BodyType
  rawSubtype: RawSubtype
  body: string
  formFields: KeyValuePair[]
  /** Staged binary file reference. Only meaningful when `bodyType === 'binary'`. */
  binaryFile?: BinaryFileAttachment
  /** Multipart parts. Only meaningful when `bodyType === 'multipart-form'`. */
  multipartParts?: MultipartPart[]
  /** Path of the currently-open workspace, or `null` when none is open. */
  workspacePath: string | null
  onBodyTypeChange: (type: BodyType) => void
  onRawSubtypeChange: (subtype: RawSubtype) => void
  onBodyChange: (value: string) => void
  onFormFieldsChange: (fields: KeyValuePair[]) => void
  onBinaryFileChange: (next: BinaryFileAttachment | undefined) => void
  onMultipartPartsChange: (parts: MultipartPart[]) => void
  /** Active environment variables — passed to the form-fields KeyValueEditor and the raw editor */
  variables?: Record<string, string | null>
  /** If true, all controls are disabled */
  readOnly?: boolean
}

function CodeMirrorEditor({
  value,
  language,
  onChange,
  readOnly = false,
  variables
}: {
  value: string
  language: CodeMirrorLanguage
  onChange: (v: string) => void
  readOnly?: boolean
  variables?: Record<string, string | null>
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  useCodeMirror(containerRef, { value, language, onChange, readOnly, variables })
  return <div ref={containerRef} className="h-full w-full" />
}

export function BodyEditor({
  bodyType,
  rawSubtype,
  body,
  formFields,
  binaryFile,
  multipartParts,
  workspacePath,
  onBodyTypeChange,
  onRawSubtypeChange,
  onBodyChange,
  onFormFieldsChange,
  onBinaryFileChange,
  onMultipartPartsChange,
  variables = {},
  readOnly = false
}: BodyEditorProps): React.JSX.Element {
  const { t } = useTranslation()

  const cmLanguage: CodeMirrorLanguage =
    bodyType === 'raw' ? RAW_SUBTYPE_LANGUAGE[rawSubtype] : 'text'
  const showCodeEditor = bodyType === 'raw'

  return (
    <div className="flex h-full flex-col">
      {/* Body type selector + raw subtype combobox (inline when bodyType === 'raw') */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-3">
        {BODY_TYPES.map((type) => (
          <label
            key={type}
            className={cn('flex items-center gap-1.5', !readOnly && 'cursor-pointer')}
          >
            <input
              type="radio"
              name="body-type"
              value={type}
              checked={bodyType === type}
              onChange={() => !readOnly && onBodyTypeChange(type)}
              disabled={readOnly}
              className="accent-primary"
            />
            <span
              className={cn(
                'text-xs',
                bodyType === type ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {t(`request.bodyTypes.${type}`)}
            </span>
          </label>
        ))}

        {bodyType === 'raw' && (
          <div className="relative flex items-center">
            <select
              value={rawSubtype}
              onChange={(e) => !readOnly && onRawSubtypeChange(e.target.value as RawSubtype)}
              disabled={readOnly}
              aria-label={t('request.body.rawSubtype.label')}
              className={cn(
                'h-7 appearance-none rounded-md border border-border-default bg-background pl-2 pr-6 text-xs',
                'focus:outline-none focus:ring-1 focus:ring-ring',
                readOnly && 'cursor-default opacity-75'
              )}
            >
              {RAW_SUBTYPES.map((subtype) => (
                <option key={subtype} value={subtype}>
                  {t(`request.body.rawSubtype.${subtype}`)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Editor area */}
      <div className="flex-1 overflow-auto">
        {bodyType === 'none' && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t('request.body.noBody')}
          </div>
        )}
        {bodyType === 'binary' && (
          <BinaryBodyPicker
            binaryFile={binaryFile}
            workspacePath={workspacePath}
            onChange={onBinaryFileChange}
            readOnly={readOnly}
          />
        )}
        {bodyType === 'multipart-form' && (
          <MultipartFormEditor
            parts={multipartParts ?? []}
            workspacePath={workspacePath}
            onChange={onMultipartPartsChange}
            readOnly={readOnly}
          />
        )}
        {bodyType === 'x-www-form-urlencoded' && (
          <KeyValueEditor
            pairs={formFields}
            onChange={onFormFieldsChange}
            keyPlaceholder={t('keyValue.keyPlaceholder')}
            valuePlaceholder={t('keyValue.valuePlaceholder')}
            variables={variables}
            readOnly={readOnly}
          />
        )}
        {showCodeEditor && (
          <div className="h-full overflow-hidden bg-background">
            <CodeMirrorEditor
              key={cmLanguage}
              value={body}
              language={cmLanguage}
              onChange={onBodyChange}
              readOnly={readOnly}
              variables={variables}
            />
          </div>
        )}
      </div>
    </div>
  )
}
