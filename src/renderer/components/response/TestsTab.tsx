import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Download, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { inspectLine } from '../../lib/inspect'
import { toJson, toJUnitXml } from '../../lib/test-results-export'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import type { ScriptResultsBundle, ScriptLog, ScriptTestResult } from '../../../shared/types'

interface TestsTabProps {
  results: ScriptResultsBundle | undefined
  requestName?: string
  url?: string
}

function summarize(results: ScriptResultsBundle): {
  tests: ScriptTestResult[]
  logs: ScriptLog[]
  errors: { phase: string; message: string }[]
} {
  const tests: ScriptTestResult[] = []
  const logs: ScriptLog[] = []
  const errors: { phase: string; message: string }[] = []

  for (const [phase, r] of [
    ['pre-request', results.preRequest],
    ['post-response', results.postResponse]
  ] as const) {
    if (!r) continue
    tests.push(...r.testResults)
    logs.push(...r.logs)
    if (!r.success && r.error) errors.push({ phase, message: r.error.message })
  }
  return { tests, logs, errors }
}

function hasContent(results: ScriptResultsBundle | undefined): boolean {
  if (!results) return false
  const { preRequest, postResponse } = results
  return (
    (preRequest?.testResults.length ?? 0) > 0 ||
    (preRequest?.logs.length ?? 0) > 0 ||
    (postResponse?.testResults.length ?? 0) > 0 ||
    (postResponse?.logs.length ?? 0) > 0
  )
}

export function TestsTab({
  results,
  requestName = 'request',
  url = ''
}: TestsTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const [clearedAt, setClearedAt] = useState<number>(0)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const consoleRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const summary = results ? summarize(results) : { tests: [], logs: [], errors: [] }
  const visibleLogs = summary.logs.filter((l) => new Date(l.timestamp).getTime() >= clearedAt)

  const passedCount = summary.tests.filter((t) => t.passed).length
  const totalCount = summary.tests.length
  const exportEnabled = hasContent(results)

  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight
    }
  }, [visibleLogs.length])

  function showToast(msg: string): void {
    setToastMsg(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 3000)
  }

  function getContext() {
    return { requestName, url, timestamp: new Date().toISOString() }
  }

  async function handleCopyJson(): Promise<void> {
    if (!results) return
    try {
      await navigator.clipboard.writeText(toJson(results, getContext()))
      showToast(t('response.tests.export.copied'))
    } catch {
      showToast(t('response.tests.export.error'))
    }
  }

  async function handleCopyJUnit(): Promise<void> {
    if (!results) return
    try {
      await navigator.clipboard.writeText(toJUnitXml(results, getContext()))
      showToast(t('response.tests.export.copied'))
    } catch {
      showToast(t('response.tests.export.error'))
    }
  }

  async function handleSaveJson(): Promise<void> {
    if (!results) return
    try {
      const content = toJson(results, getContext())
      const res = await window.api.file.saveDialog({
        defaultName: `${requestName}-tests.json`,
        content,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (!res.canceled && res.path) {
        showToast(t('response.tests.export.saved', { path: res.path }))
      }
    } catch {
      showToast(t('response.tests.export.error'))
    }
  }

  async function handleSaveJUnit(): Promise<void> {
    if (!results) return
    try {
      const content = toJUnitXml(results, getContext())
      const res = await window.api.file.saveDialog({
        defaultName: `${requestName}-tests.xml`,
        content,
        filters: [{ name: 'JUnit XML', extensions: ['xml'] }]
      })
      if (!res.canceled && res.path) {
        showToast(t('response.tests.export.saved', { path: res.path }))
      }
    } catch {
      showToast(t('response.tests.export.error'))
    }
  }

  if (!results) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t('response.tests.empty')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toast */}
      {toastMsg && (
        <div className="absolute bottom-4 right-4 z-50 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
          {toastMsg}
        </div>
      )}

      {summary.errors.length > 0 && (
        <div className="space-y-2 border-b border-border bg-danger/5 p-3">
          {summary.errors.map((e, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger-text" />
              <div className="flex-1">
                <div className="font-medium text-danger-text">
                  {t('response.tests.errorIn', { phase: e.phase })}
                </div>
                <div className="mt-0.5 break-all font-mono text-muted-foreground">{e.message}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Test Results */}
      <div className="flex flex-col border-b border-border">
        <div className="flex items-center justify-between bg-surface-2 px-3 py-1.5 text-xs">
          <span className="font-medium text-foreground">{t('response.tests.testResults')}</span>
          <div className="flex items-center gap-2">
            {totalCount > 0 && (
              <span className="font-mono text-muted-foreground">
                {t('response.tests.summary', { passed: passedCount, total: totalCount })}
              </span>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={!exportEnabled}
                  title={t('response.tests.export.button')}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <Download className="h-3 w-3" />
                  {t('response.tests.export.button')}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={handleCopyJson}>
                  {t('response.tests.export.copyJson')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleCopyJUnit}>
                  {t('response.tests.export.copyJUnit')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={handleSaveJson}>
                  {t('response.tests.export.saveJson')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleSaveJUnit}>
                  {t('response.tests.export.saveJUnit')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="max-h-60 overflow-auto">
          {summary.tests.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t('response.tests.noTests')}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {summary.tests.map((tr, i) => (
                <li key={i} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                  {tr.passed ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-success-text" />
                  ) : (
                    <X className="h-3.5 w-3.5 shrink-0 text-danger-text" />
                  )}
                  <div className="flex-1">
                    <div
                      className={cn(
                        'font-medium',
                        tr.passed ? 'text-foreground' : 'text-danger-text'
                      )}
                    >
                      {tr.name}
                    </div>
                    {!tr.passed && tr.error && (
                      <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
                        {tr.error}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Console */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between bg-surface-2 px-3 py-1.5 text-xs">
          <span className="font-medium text-foreground">{t('response.tests.console')}</span>
          <button
            type="button"
            onClick={() => setClearedAt(Date.now())}
            title={t('response.tests.clearConsole')}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Trash2 className="h-3 w-3" />
            {t('response.tests.clearConsole')}
          </button>
        </div>
        <div ref={consoleRef} className="flex-1 overflow-auto bg-background font-mono text-[11px]">
          {visibleLogs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {t('response.tests.consoleEmpty')}
            </div>
          ) : (
            <ul className="divide-y divide-border/50">
              {visibleLogs.map((log, i) => (
                <li
                  key={i}
                  className={cn(
                    'flex items-start gap-2 px-3 py-1',
                    log.level === 'warn' && 'text-warning-text',
                    log.level === 'error' && 'text-danger-text'
                  )}
                >
                  <span className="shrink-0 text-muted-foreground">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="shrink-0 uppercase opacity-60">{log.level}</span>
                  <span className="flex-1 break-all">{inspectLine(log.args)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

export function countTestFailures(results: ScriptResultsBundle | undefined): number {
  if (!results) return 0
  let n = 0
  for (const r of [results.preRequest, results.postResponse]) {
    if (!r) continue
    for (const tr of r.testResults) if (!tr.passed) n++
    if (!r.success) n++
  }
  return n
}
