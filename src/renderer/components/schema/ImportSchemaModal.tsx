import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Upload,
  FileText,
  Link as LinkIcon,
  ClipboardPaste,
  Loader2,
  AlertCircle,
  Info
} from 'lucide-react'
import { activeSourceContent, useSchemaImportStore } from '../../stores/schemaImport'
import { useEnvironmentStore } from '../../stores/environment'
import { useWorkspaceStore } from '../../stores/workspace'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '../../lib/utils'
import type { SchemaFormat, SchemaImportRequest } from '../../../shared/types'
import { deriveEnvFolderName } from '../../../shared/lib/env-folder-name'
import { ImportResultSummary } from './ImportResultSummary'
import { schemaImportErrorText } from './schema-import-error'

const FORMAT_OPTIONS: Array<SchemaFormat | 'auto'> = [
  'auto',
  'openapi',
  'swagger',
  'graphql-sdl',
  'graphql-introspection',
  'wsdl',
  'postman'
]

export function ImportSchemaModal(): React.JSX.Element | null {
  const { t } = useTranslation()
  const state = useSchemaImportStore()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  // Subscribe to progress events while the modal is open
  useEffect(() => {
    if (!state.isOpen) return
    const unsub = window.api.schema.onProgress((p) => {
      useSchemaImportStore.getState().setProgress(p)
    })
    return unsub
  }, [state.isOpen])

  // The active tab's local content: what detection reads and *Import* sends.
  const content = activeSourceContent(state)

  // Auto-detect format when the active tab's content changes and format = 'auto'.
  // A tab with no local content (URL, or nothing picked/typed) detects nothing.
  useEffect(() => {
    if (state.format !== 'auto' || !content) {
      state.setDetectedFormat(null)
      return
    }
    let cancelled = false
    window.api.schema
      .detectFormat(content)
      .then((fmt) => {
        if (!cancelled) state.setDetectedFormat(fmt)
      })
      .catch(() => {
        if (!cancelled) state.setDetectedFormat(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, state.format])

  const handlePickFile = (): void => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    state.setFileContent(file.name, text)
  }

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const text = await file.text()
    state.setFileContent(file.name, text)
  }

  const effectiveFormat: SchemaFormat | null =
    state.format === 'auto' ? state.detectedFormat : state.format
  const needsEnvName = effectiveFormat === 'postman' && state.environmentStrategy === 'new'

  const canImport = useMemo(() => {
    if (state.isImporting) return false
    if (needsEnvName && state.environmentName.trim().length === 0) return false
    if (state.sourceKind === 'url') return /^https?:\/\//i.test(state.urlValue.trim())
    return content.trim().length > 0
  }, [
    state.isImporting,
    state.sourceKind,
    content,
    state.urlValue,
    state.environmentName,
    needsEnvName
  ])

  const handleImport = async (): Promise<void> => {
    if (!state.targetFolder) return

    // Pre-import validation: reject the environment name before writing anything.
    // Uniqueness is on the **derived folder**, case-insensitively — the same rule
    // the business layer enforces, checked here so nothing is written first.
    if (effectiveFormat === 'postman' && state.environmentStrategy === 'new') {
      const envName = state.environmentName.trim()
      if (envName) {
        const folder = deriveEnvFolderName(envName)
        if (!folder) {
          state.setError(t('environment.errors.nameEmpty'))
          return
        }
        const occupant = useEnvironmentStore
          .getState()
          .environments.find((e) => e.folder.toLowerCase() === folder.toLowerCase())
        if (occupant) {
          state.setError(t('environment.errors.folderConflict', { name: occupant.name }))
          return
        }
      }
    }

    state.setImporting(true)
    state.setError(null)
    state.setResult(null)
    state.setProgress(null)

    try {
      const source: SchemaImportRequest['source'] =
        state.sourceKind === 'url'
          ? { kind: 'url', value: state.urlValue.trim() }
          : { kind: 'text', value: content }

      const req: SchemaImportRequest = {
        source,
        format: state.format,
        targetFolder: state.targetFolder,
        collectionName: state.collectionName.trim() || undefined,
        conflictStrategy: state.conflictStrategy,
        postman:
          effectiveFormat === 'postman'
            ? {
                environmentStrategy: state.environmentStrategy,
                environmentName:
                  state.environmentStrategy === 'new'
                    ? state.environmentName.trim() || undefined
                    : undefined,
                mergeEnvironmentId:
                  state.environmentStrategy === 'merge' && state.activeEnvId
                    ? state.activeEnvId
                    : undefined
              }
            : undefined
      }

      const result = await window.api.schema.import(req)
      state.setResult(result)
      if (result.environmentCreated || result.environmentMerged) {
        const workspacePath = useWorkspaceStore.getState().workspacePath
        if (workspacePath) {
          useEnvironmentStore.getState().loadEnvironments(workspacePath).catch(console.error)
        }
      }
    } catch (err) {
      state.setError(schemaImportErrorText(err, t))
    } finally {
      state.setImporting(false)
      state.setProgress(null)
    }
  }

  if (!state.isOpen) return null

  const showResult = !!state.result

  return (
    <Dialog
      open={state.isOpen}
      onOpenChange={(open) => {
        if (!open) state.close()
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            {t('schemaImport.title')}
          </DialogTitle>
          <DialogDescription>
            {t('schemaImport.target', { path: state.targetLabel ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {showResult ? (
          <>
            <ImportResultSummary result={state.result!} />
            <DialogFooter>
              <Button variant="outline" onClick={() => state.close()}>
                {t('schemaImport.actions.close')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <Tabs
                value={state.sourceKind}
                onValueChange={(v) => state.setSourceKind(v as typeof state.sourceKind)}
              >
                <TabsList>
                  <TabsTrigger value="file">
                    <FileText className="mr-1 h-3.5 w-3.5" />
                    {t('schemaImport.source.file')}
                  </TabsTrigger>
                  <TabsTrigger value="url">
                    <LinkIcon className="mr-1 h-3.5 w-3.5" />
                    {t('schemaImport.source.url')}
                  </TabsTrigger>
                  <TabsTrigger value="text">
                    <ClipboardPaste className="mr-1 h-3.5 w-3.5" />
                    {t('schemaImport.source.text')}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="file" className="pt-3">
                  <div
                    onDragOver={(e) => {
                      e.preventDefault()
                      setIsDragOver(true)
                    }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={handleDrop}
                    className={cn(
                      'flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground',
                      isDragOver && 'border-primary bg-primary/5'
                    )}
                  >
                    <Upload className="h-5 w-5" />
                    <p>{t('schemaImport.source.fileHint')}</p>
                    <Button type="button" variant="outline" onClick={handlePickFile}>
                      {t('schemaImport.source.browse')}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,.yaml,.yml,.graphql,.gql,.wsdl,.xml,.txt"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                    {state.fileName && <p className="text-foreground">{state.fileName}</p>}
                  </div>
                </TabsContent>

                <TabsContent value="url" className="pt-3">
                  <Input
                    value={state.urlValue}
                    placeholder="https://example.com/openapi.yaml"
                    onChange={(e) => state.setUrlValue(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('schemaImport.source.urlHint')}
                  </p>
                </TabsContent>

                <TabsContent value="text" className="pt-3">
                  <textarea
                    value={state.textValue}
                    onChange={(e) => state.setTextValue(e.target.value)}
                    placeholder={t('schemaImport.source.textPlaceholder')}
                    className="h-36 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </TabsContent>
              </Tabs>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {t('schemaImport.format.label')}
                  </label>
                  <select
                    value={state.format}
                    onChange={(e) => state.setFormat(e.target.value as SchemaFormat | 'auto')}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {FORMAT_OPTIONS.map((f) => (
                      <option key={f} value={f}>
                        {t(`schemaImport.format.${f}`)}
                      </option>
                    ))}
                  </select>
                  {state.format === 'auto' && state.detectedFormat && (
                    <span className="text-[11px] text-muted-foreground">
                      {t('schemaImport.format.detected', { format: state.detectedFormat })}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {t('schemaImport.collectionName.label')}
                  </label>
                  <Input
                    value={state.collectionName}
                    placeholder={t('schemaImport.collectionName.placeholder')}
                    onChange={(e) => state.setCollectionName(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {t('schemaImport.conflict.label')}
                </label>
                <div className="flex gap-2">
                  {(['merge', 'abort'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => state.setConflictStrategy(s)}
                      className={cn(
                        'flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors',
                        state.conflictStrategy === s
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                      )}
                    >
                      {t(`schemaImport.conflict.${s}`)}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t(`schemaImport.conflict.${state.conflictStrategy}Hint`)}
                </p>
              </div>

              {effectiveFormat === 'postman' && (
                <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-3">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {t('schemaImport.postman.envLabel')}
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    {t('schemaImport.postman.envHint')}
                  </p>
                  <div className="mt-1 flex gap-2">
                    {(['new', 'merge', 'none'] as const).map((s) => {
                      const disabled = s === 'merge' && !state.activeEnvId
                      return (
                        <button
                          key={s}
                          type="button"
                          disabled={disabled}
                          onClick={() => state.setEnvironmentStrategy(s)}
                          className={cn(
                            'flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors',
                            state.environmentStrategy === s
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
                            disabled &&
                              'cursor-not-allowed opacity-40 hover:border-border hover:text-muted-foreground'
                          )}
                        >
                          {t(`schemaImport.postman.strategy.${s}`)}
                        </button>
                      )
                    })}
                  </div>
                  {state.environmentStrategy === 'new' && (
                    <div className="mt-2 flex flex-col gap-1">
                      <label className="text-[11px] text-muted-foreground">
                        {t('schemaImport.postman.envNameLabel')}
                      </label>
                      <Input
                        value={state.environmentName}
                        placeholder={t('schemaImport.postman.envNamePlaceholder')}
                        onChange={(e) => state.setEnvironmentName(e.target.value)}
                        className={cn(
                          state.environmentName.trim().length === 0 && 'border-destructive/60'
                        )}
                      />
                      {state.environmentName.trim().length === 0 && (
                        <span className="text-[11px] text-destructive">
                          {t('schemaImport.postman.envNameRequired')}
                        </span>
                      )}
                    </div>
                  )}
                  {state.environmentStrategy === 'merge' && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {state.activeEnvName
                        ? t('schemaImport.postman.mergeTarget', { name: state.activeEnvName })
                        : t('schemaImport.postman.mergeNoActive')}
                    </p>
                  )}
                </div>
              )}

              {effectiveFormat === 'wsdl' && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>{t('schemaImport.wsdl.note')}</p>
                </div>
              )}

              {state.isImporting && (
                <div className="flex items-center gap-2 rounded border border-border bg-surface-2 px-3 py-2 text-xs">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  <div className="flex flex-1 flex-col">
                    <span className="text-foreground">
                      {state.progress
                        ? t(`schemaImport.progress.${state.progress.phase}`)
                        : t('schemaImport.progress.starting')}
                    </span>
                    {state.progress && state.progress.total > 0 && (
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-1 bg-primary transition-all"
                          style={{
                            width: `${Math.min(
                              100,
                              Math.round(
                                (state.progress.current / Math.max(1, state.progress.total)) * 100
                              )
                            )}%`
                          }}
                        />
                      </div>
                    )}
                    {state.progress?.message && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {state.progress.message}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {state.error && (
                <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>{state.error}</p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => state.close()}
                disabled={state.isImporting}
              >
                {t('schemaImport.actions.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => handleImport().catch(console.error)}
                disabled={
                  !canImport ||
                  (state.format === 'auto' && state.sourceKind !== 'url' && !effectiveFormat)
                }
              >
                {state.isImporting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t('schemaImport.actions.import')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
