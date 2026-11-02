import { useRef, useState, useCallback, useEffect } from 'react'
import { Copy, Check, AlignLeft, Code, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useRequestStore } from '../../stores/request'
import { useUiStateStore } from '../../stores/uiState'
import { useCodeMirror } from '../../hooks/useCodeMirror'
import type { CodeMirrorLanguage } from '../../hooks/useCodeMirror'
import type { HttpResponse, ResponseViewerTab, ScriptResultsBundle } from '../../../shared/types'
import { prettyPrintJson, prettyPrintXml, sniffLanguage } from '../../lib/format-body'
import { TestsTab, countTestFailures } from './TestsTab'
import { CookiesTab, cookieRowCount, cookieWarningsOf } from './CookiesTab'

type ResponseTab = ResponseViewerTab

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTiming(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function getStatusColor(status: number): string {
  if (status >= 500) return 'text-danger-text'
  if (status >= 400) return 'text-warning-text'
  if (status === 304) return 'text-info-text opacity-70'
  if (status >= 300) return 'text-info-text'
  if (status === 202 || status === 204) return 'text-success-text opacity-70'
  if (status >= 200) return 'text-success-text'
  return 'text-muted-foreground'
}

function detectLanguage(headers: Record<string, string>, body: string): CodeMirrorLanguage {
  const ct = (
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  ).toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('html')) return 'html' // text/html, application/xhtml+xml
  if (ct.includes('xml')) return 'xml' // application/xml, text/xml, application/soap+xml, *+xml
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript'
  // Generic / missing content type — fall back to sniffing the body itself.
  if (ct === '' || ct.startsWith('text/plain') || ct.startsWith('application/octet-stream')) {
    return sniffLanguage(body) ?? 'text'
  }
  return 'text'
}

function isImageResponse(headers: Record<string, string>): boolean {
  const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  return ct.startsWith('image/')
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ReadOnlyCodeMirror({
  value,
  language
}: {
  value: string
  language: CodeMirrorLanguage
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  useCodeMirror(containerRef, { value, language, onChange: () => {}, readOnly: true })
  return <div ref={containerRef} className="h-full w-full" />
}

function BodyTab({ response }: { response: HttpResponse }): React.JSX.Element {
  const { t } = useTranslation()
  const language = detectLanguage(response.headers, response.body)
  const isImage = isImageResponse(response.headers)
  const canPretty = language === 'json' || language === 'xml'
  const [isPretty, setIsPretty] = useState(true)
  const [copied, setCopied] = useState(false)

  const displayBody = !isPretty
    ? response.body
    : language === 'json'
      ? prettyPrintJson(response.body)
      : language === 'xml'
        ? prettyPrintXml(response.body)
        : response.body

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(displayBody).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [displayBody])

  if (isImage) {
    const ct =
      Object.entries(response.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ??
      'image/png'
    return (
      <div className="flex h-full items-center justify-center p-4 overflow-auto">
        <img
          src={`data:${ct};base64,${response.body}`}
          alt={t('response.body.imageAlt')}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1 shrink-0">
        <button
          onClick={handleCopy}
          title={t('response.body.copy')}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {t('response.body.copy')}
        </button>

        {canPretty && (
          <>
            <button
              onClick={() => setIsPretty(true)}
              title={t('response.body.prettyPrint')}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
                isPretty
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <AlignLeft className="h-3 w-3" />
              {t('response.body.prettyPrint')}
            </button>
            <button
              onClick={() => setIsPretty(false)}
              title={t('response.body.raw')}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
                !isPretty
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Code className="h-3 w-3" />
              {t('response.body.raw')}
            </button>
          </>
        )}
      </div>

      {/* CodeMirror body */}
      <div className="flex-1 overflow-hidden bg-background">
        <ReadOnlyCodeMirror
          key={`${language}-${isPretty}`}
          value={displayBody}
          language={language}
        />
      </div>
    </div>
  )
}

function HeadersTab({ response }: { response: HttpResponse }): React.JSX.Element {
  const { t } = useTranslation()
  const entries = Object.entries(response.headers)

  return (
    <div className="h-full overflow-auto">
      {entries.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {t('response.headers.empty')}
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground w-2/5">
                {t('response.headers.name')}
              </th>
              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">
                {t('response.headers.value')}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-b border-border/50 hover:bg-surface-2">
                <td className="px-3 py-1 font-mono text-primary/80 break-all">{key}</td>
                <td className="px-3 py-1 font-mono text-foreground break-all">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function EmptyResponseState(): React.JSX.Element {
  const { t } = useTranslation()
  const tips = t('response.emptyTips', { returnObjects: true }) as string[]
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * tips.length))

  useEffect(() => {
    const interval = setInterval(() => {
      setTipIndex((i) => (i + 1) % tips.length)
    }, 6000)
    return () => clearInterval(interval)
  }, [tips.length])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="rounded-full bg-primary/10 p-3 text-primary">
        <Zap className="h-6 w-6" strokeWidth={1.75} />
      </div>
      <div className="flex flex-col items-center gap-2">
        <p className="text-sm font-medium text-foreground">{t('response.emptyTitle')}</p>
        <p className="flex flex-wrap items-center justify-center gap-1 text-xs text-muted-foreground">
          <span>{t('response.empty')}</span>
        </p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            Ctrl
          </kbd>
          <span>+</span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            Enter
          </kbd>
          <span className="ml-1">{t('request.send').toLowerCase()}</span>
        </p>
      </div>
      <p
        key={tipIndex}
        className="max-w-xs text-[11px] italic text-muted-foreground/80 transition-opacity"
      >
        {tips[tipIndex]}
      </p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ResponseViewer(): React.JSX.Element {
  const { t } = useTranslation()

  const activeWorkspaceTab = useRequestStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId) ?? null
  )
  const updateTab = useRequestStore((s) => s.updateTab)
  // Persisted per-request: read from the tab (hydrated by openTab) and fall back to 'body'.
  const activeTab: ResponseTab = activeWorkspaceTab?.activeResponseTab ?? 'body'
  const setActiveTab = useCallback(
    (key: ResponseTab) => {
      if (!activeWorkspaceTab) return
      updateTab(activeWorkspaceTab.id, { activeResponseTab: key })
      if (activeWorkspaceTab.requestId) {
        useUiStateStore.getState().setForRequest(activeWorkspaceTab.requestId, {
          activeResponseTab: key
        })
      }
    },
    [activeWorkspaceTab, updateTab]
  )

  const response: HttpResponse | null = activeWorkspaceTab?.response ?? null
  const isLoading: boolean = activeWorkspaceTab?.isLoading ?? false
  const error: string | null = activeWorkspaceTab?.error ?? null
  const scriptResults: ScriptResultsBundle | undefined = activeWorkspaceTab?.scriptResults
  const cookies = activeWorkspaceTab?.cookies
  const cookieWarnings = cookieWarningsOf(activeWorkspaceTab?.warnings)
  const failingTests = countTestFailures(scriptResults)
  const tabTitle: string = activeWorkspaceTab?.title ?? 'request'
  const tabUrl: string = activeWorkspaceTab?.request?.url ?? ''

  // A badge's colour has to match what its number means. The Tests badge counts
  // *failures*, so red is the message. A Cookies count is neutral information —
  // painting it red says "something is wrong" on every ordinary send, which
  // drains the colour of meaning by the time it matters.
  const tabs_: {
    key: ResponseTab
    label: string
    badge?: number
    tone?: 'danger' | 'neutral'
    mark?: boolean
  }[] = [
    { key: 'body', label: t('response.tabs.body') },
    {
      key: 'cookies',
      label: t('response.tabs.cookies'),
      badge: cookieRowCount(cookies),
      tone: 'neutral',
      // REQ-0115: a distinct non-numeric mark, so a send whose cookie was refused
      // is noticeable without reading — the count alone would say nothing, and in
      // the rejection case it is usually zero.
      mark: cookieWarnings.length > 0
    },
    { key: 'headers', label: t('response.tabs.headers') },
    { key: 'tests', label: t('response.tabs.tests'), badge: failingTests, tone: 'danger' }
  ]

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Top bar: tabs + response metadata */}
      <div className="flex h-8 items-center justify-between border-b border-border bg-surface-2 px-3 shrink-0">
        {/* Tabs */}
        <div className="flex h-full items-center">
          {tabs_.map(({ key, label, badge, tone, mark }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={cn(
                'flex h-8 items-center gap-1.5 px-4 text-xs transition-colors',
                activeTab === key
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
              {/* `leading-none` matters: an arbitrary font size keeps the
                  inherited line-height, so the text's line box is taller than the
                  16px circle and `items-center` centres a box that overflows it —
                  the digit ends up sitting low. */}
              {badge !== undefined && badge > 0 && (
                <span
                  className={cn(
                    'inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none',
                    tone === 'danger' ? 'bg-danger text-white' : 'bg-muted text-muted-foreground'
                  )}
                >
                  {badge}
                </span>
              )}
              {mark && (
                <span
                  aria-label={t('response.cookies.hasWarnings')}
                  title={t('response.cookies.hasWarnings')}
                  className="inline-block h-1.5 w-1.5 rounded-full bg-warning"
                />
              )}
            </button>
          ))}
        </div>

        {/* Response metadata */}
        {response && (
          <div className="flex items-center gap-3">
            <span
              key={`${response.status}-${response.timingMs}`}
              className={cn(
                'rounded-md px-1.5 py-0.5 text-sm font-semibold',
                getStatusColor(response.status),
                response.status >= 200 && response.status < 300 && 'animate-flash-success'
              )}
            >
              {response.status} {response.statusText}
            </span>
            <span className="text-xs text-muted-foreground">{formatTiming(response.timingMs)}</span>
            <span className="text-xs text-muted-foreground">{formatSize(response.sizeBytes)}</span>
          </div>
        )}
      </div>

      {/* Body area */}
      <div className="flex-1 overflow-hidden">
        {/* Loading state */}
        {isLoading && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <svg
              className="h-5 w-5 animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-xs">{t('response.loading')}</span>
          </div>
        )}

        {/* Tests tab is available even on error/empty state if scripts ran */}
        {!isLoading && activeTab === 'tests' && (
          <TestsTab results={scriptResults} requestName={tabTitle} url={tabUrl} />
        )}

        {/* REQ-0115: Cookies is available on the error state too. A chain can hand
            over its session on one hop and fail on the next — that is precisely the
            send whose cookies the user needs to see. */}
        {!isLoading && activeTab === 'cookies' && (
          <CookiesTab cookies={cookies} warnings={activeWorkspaceTab?.warnings} />
        )}

        {/* Error state (non-tests tab) */}
        {!isLoading && error && activeTab !== 'tests' && activeTab !== 'cookies' && (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <span className="text-xs font-medium text-red-500">{t('response.error')}</span>
            <span className="text-xs text-muted-foreground">{error}</span>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && !response && activeTab !== 'tests' && activeTab !== 'cookies' && (
          <EmptyResponseState />
        )}

        {/* Response content */}
        {!isLoading && !error && response && activeTab !== 'tests' && (
          <>
            {activeTab === 'body' && <BodyTab response={response} />}
            {activeTab === 'headers' && <HeadersTab response={response} />}
          </>
        )}
      </div>
    </div>
  )
}
