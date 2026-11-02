import { useTranslation } from 'react-i18next'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import type { SchemaImportResult, SchemaImportWarningKind } from '../../../shared/types'

interface Props {
  result: SchemaImportResult
}

export function ImportResultSummary({ result }: Props): React.JSX.Element {
  const { t } = useTranslation()

  const grouped = new Map<SchemaImportWarningKind, string[]>()
  for (const w of result.warnings) {
    if (!grouped.has(w.kind)) grouped.set(w.kind, [])
    const arr = grouped.get(w.kind)!
    const loc = w.location ? `${w.location}: ` : ''
    arr.push(`${loc}${w.message}`)
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-start gap-2 rounded border border-primary/30 bg-primary/5 px-3 py-2">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground">
            {t('schemaImport.result.success', { title: result.schemaTitle })}
          </p>
          <p className="text-muted-foreground">
            {t('schemaImport.result.summary', {
              operations: result.operationsCreated,
              folders: result.foldersCreated,
              format: result.detectedFormat
            })}
          </p>
          <p className="text-muted-foreground truncate" title={result.collectionPath}>
            {result.collectionPath}
          </p>
          {result.environmentCreated && (
            <p className="text-muted-foreground">
              {t('schemaImport.result.envCreated', { id: result.environmentCreated })}
            </p>
          )}
          {result.environmentMerged && (
            <p className="text-muted-foreground">
              {t('schemaImport.result.envMerged', { id: result.environmentMerged })}
            </p>
          )}
        </div>
      </div>

      {grouped.size > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <AlertTriangle className="h-3 w-3" />
            {t('schemaImport.result.warnings', { count: result.warnings.length })}
          </div>
          <div className="flex flex-col gap-2 rounded border border-border bg-surface-2 p-2 max-h-40 overflow-y-auto">
            {[...grouped.entries()].map(([kind, messages]) => (
              <div key={kind} className="flex flex-col gap-0.5">
                <span className="text-[11px] font-medium text-foreground">
                  {t(`schemaImport.warningKind.${kind}`)}
                </span>
                <ul className="ml-3 list-disc text-muted-foreground">
                  {messages.slice(0, 20).map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                  {messages.length > 20 && (
                    <li className="italic">
                      {t('schemaImport.result.andMore', { count: messages.length - 20 })}
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
