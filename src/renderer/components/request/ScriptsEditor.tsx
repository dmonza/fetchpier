import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useScriptEditor } from '../../hooks/useScriptEditor'
import type { ScriptPhase as TsLangScriptPhase } from '../../hooks/tsLanguageService'
import type { ScriptPhase } from '../../../shared/types'

type ScriptType = 'pre-request' | 'post-response'

const PHASE_BY_SCRIPT_TYPE: Record<ScriptType, TsLangScriptPhase> = {
  'pre-request': 'preRequest',
  'post-response': 'postResponse'
}

const SCRIPT_TYPE_BY_PHASE: Record<ScriptPhase, ScriptType> = {
  pre: 'pre-request',
  post: 'post-response'
}

const PHASE_BY_LOCAL: Record<ScriptType, ScriptPhase> = {
  'pre-request': 'pre',
  'post-response': 'post'
}

interface ScriptsEditorProps {
  preRequestScript: string
  postResponseScript: string
  onPreRequestChange: (script: string) => void
  onPostResponseChange: (script: string) => void
  /**
   * When provided, this is the persisted active phase. Falls back to the
   * smart-default heuristic (prefer 'pre' unless empty and 'post' has content)
   * the first time `undefined` is passed. Subsequent renders use the value.
   */
  activePhase?: ScriptPhase
  /** Called when the user switches phase. Wired by the parent into both the request store and the uiState store. */
  onPhaseChange?: (phase: ScriptPhase) => void
  readOnly?: boolean
}

function ScriptCodeEditor({
  value,
  onChange,
  phase,
  readOnly = false
}: {
  value: string
  onChange: (v: string) => void
  phase: TsLangScriptPhase
  readOnly?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const { loading, error } = useScriptEditor(containerRef, {
    value,
    onChange,
    phase,
    readOnly
  })
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {(loading || error) && (
        <div className="pointer-events-none absolute right-2 top-2 select-none rounded border border-border bg-muted/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
          {error
            ? t('request.scripts.intellisenseLoadError')
            : t('request.scripts.intellisenseLoading')}
        </div>
      )}
    </div>
  )
}

export function ScriptsEditor({
  preRequestScript,
  postResponseScript,
  onPreRequestChange,
  onPostResponseChange,
  activePhase,
  onPhaseChange,
  readOnly = false
}: ScriptsEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  // Smart-default fallback when no persisted phase exists yet.
  const [localScript, setLocalScript] = useState<ScriptType>(() =>
    preRequestScript.trim().length === 0 && postResponseScript.trim().length > 0
      ? 'post-response'
      : 'pre-request'
  )
  const activeScript: ScriptType =
    activePhase !== undefined ? SCRIPT_TYPE_BY_PHASE[activePhase] : localScript

  const handlePhaseChange = (key: ScriptType): void => {
    setLocalScript(key)
    onPhaseChange?.(PHASE_BY_LOCAL[key])
  }

  const SCRIPT_TYPES: { key: ScriptType; label: string }[] = [
    { key: 'pre-request', label: t('request.scripts.preRequest') },
    { key: 'post-response', label: t('request.scripts.postResponse') }
  ]

  const value = activeScript === 'pre-request' ? preRequestScript : postResponseScript
  const onChange = activeScript === 'pre-request' ? onPreRequestChange : onPostResponseChange

  return (
    <div className="flex h-full flex-col">
      {/* Script type selector */}
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5">
        {SCRIPT_TYPES.map(({ key, label }) => (
          <label
            key={key}
            className={cn('flex items-center gap-1.5', !readOnly && 'cursor-pointer')}
          >
            <input
              type="radio"
              name="script-type"
              value={key}
              checked={activeScript === key}
              onChange={() => handlePhaseChange(key)}
              disabled={readOnly}
              className="accent-primary"
            />
            <span
              className={cn(
                'text-xs',
                activeScript === key ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {label}
            </span>
          </label>
        ))}
      </div>

      {/* Editor area */}
      <div className="flex-1 overflow-hidden bg-background">
        <ScriptCodeEditor
          key={activeScript}
          value={value}
          onChange={onChange}
          phase={PHASE_BY_SCRIPT_TYPE[activeScript]}
          readOnly={readOnly}
        />
      </div>
    </div>
  )
}
