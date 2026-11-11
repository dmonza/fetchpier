import { promises as fs } from 'node:fs'
import { escapeHtml } from '../output/escape'
import { formatDuration, formatSize } from '../output/formatters'
import { findingMessage } from '../output/findings-messages'
import type { RequestUnit, RunSummary } from '../types'
import type { Reporter, RunMeta, UnitStart } from './types'
import { responselessLabel } from './unit-outcome'

export interface HtmlReporterOptions {
  output: string
  /** Start with the "only failures" filter active. */
  onlyFailures?: boolean
}

function unitFailed(u: RequestUnit): boolean {
  return (
    u.tests.some((t) => !t.passed) ||
    !u.response ||
    (u.scripts.preRequest?.errors.length ?? 0) > 0 ||
    (u.scripts.postResponse?.errors.length ?? 0) > 0
  )
}

/**
 * Standalone single-file HTML reporter. All CSS and JS are inlined (no CDN), so
 * it works offline and on locked-down intranets — meant to be uploaded as a CI
 * artifact, not to be a mini-app. Includes a dark/light toggle and an "only
 * failures" filter. Every piece of dynamic text is HTML-escaped.
 */
export class HtmlReporter implements Reporter {
  private summary?: RunSummary
  constructor(private readonly opts: HtmlReporterOptions) {}

  runStart(_meta: RunMeta): void {}
  unitStart(_unit: UnitStart): void {}
  unitComplete(_unit: RequestUnit): void {}
  runComplete(summary: RunSummary): void {
    this.summary = summary
  }
  error(): void {}
  warn(): void {}
  log(): void {}

  async finalize(): Promise<void> {
    if (!this.summary) return
    await fs.writeFile(this.opts.output, this.render(this.summary), 'utf-8')
  }

  private render(s: RunSummary): string {
    const { requests, tests, scriptErrors } = s.summary
    const bodyClass = this.opts.onlyFailures ? 'only-failures' : ''
    return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fetchpier run report</title>
<style>${STYLE}</style>
</head>
<body class="${bodyClass}">
<header>
  <h1>Fetchpier run report</h1>
  <dl class="meta">
    <div><dt>Workspace</dt><dd>${escapeHtml(s.workspace)}</dd></div>
    <div><dt>Environment</dt><dd>${escapeHtml(s.environmentName ?? s.environment)}</dd></div>
    <div><dt>Started</dt><dd>${escapeHtml(s.startedAt)}</dd></div>
    <div><dt>Duration</dt><dd>${formatDuration(s.durationMs)}</dd></div>
  </dl>
  <div class="controls">
    <button id="theme">Toggle theme</button>
    <button id="filter">Toggle only failures</button>
  </div>
</header>
<section class="cards">
  <div class="card"><span class="n">${requests.total}</span><span>requests</span></div>
  <div class="card ${tests.failed ? 'bad' : 'good'}"><span class="n">${tests.passed}/${tests.total}</span><span>tests passed</span></div>
  <div class="card ${tests.failed ? 'bad' : ''}"><span class="n">${tests.failed}</span><span>failed</span></div>
  <div class="card ${scriptErrors ? 'bad' : ''}"><span class="n">${scriptErrors}</span><span>script errors</span></div>${
    s.findingsSummary
      ? `\n  <div class="card"><span class="n">${
          s.findingsSummary.bySeverity.high +
          s.findingsSummary.bySeverity.medium +
          s.findingsSummary.bySeverity.low +
          s.findingsSummary.bySeverity.info
        }</span><span>security findings (${s.findingsSummary.bySeverity.high} high, ${
          s.findingsSummary.bySeverity.medium
        } medium, ${s.findingsSummary.bySeverity.low} low, ${s.findingsSummary.bySeverity.info} info)</span></div>`
      : ''
  }
</section>
<main>
${s.units.map((u) => this.renderUnit(u)).join('\n')}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`
  }

  private renderUnit(u: RequestUnit): string {
    const failed = unitFailed(u)
    const status = u.response
      ? `${u.response.status} ${escapeHtml(u.response.statusText)}`
      : responselessLabel(u)
    // REQ-0111: when nothing came back, the reason is the only useful thing to
    // show in place of the timing/size metadata.
    const meta = u.response
      ? `${formatDuration(u.response.timingMs)} · ${
          u.response.decodingStatus === 'decoded' &&
          u.response.compressedBytes !== undefined &&
          u.response.decompressedBytes !== undefined
            ? `${formatSize(u.response.compressedBytes)} (${formatSize(u.response.decompressedBytes)} decoded)`
            : formatSize(u.response.sizeBytes)
        }`
      : u.error
        ? escapeHtml(u.error)
        : ''
    const tests = u.tests
      .map(
        (t) =>
          `<li class="${t.passed ? 'pass' : 'fail'}">${t.passed ? '✓' : '✗'} ${escapeHtml(
            t.name
          )}${t.error ? `<pre>${escapeHtml(t.error)}</pre>` : ''}</li>`
      )
      .join('')
    const scriptErrs = [
      ...(u.scripts.preRequest?.errors ?? []),
      ...(u.scripts.postResponse?.errors ?? [])
    ]
      .map((e) => `<li class="fail">✗ ${escapeHtml(e.message)}</li>`)
      .join('')

    return `<details class="unit ${failed ? 'unit-fail' : 'unit-pass'}" ${failed ? 'open' : ''}>
  <summary><span class="badge ${failed ? 'bad' : 'good'}">${u.request.method}</span> ${escapeHtml(
    u.path
  )} <span class="status">${status}</span> <span class="muted">${meta}</span></summary>
  <div class="detail">
    <h3>Request</h3>
    <pre>${escapeHtml(u.request.method)} ${escapeHtml(u.request.url)}\n${headerBlock(u.request.headers)}</pre>
    ${u.request.body ? `<pre class="body">${escapeHtml(u.request.body)}</pre>` : ''}
    ${
      u.response
        ? `<h3>Response</h3><pre>${headerBlock(u.response.headers)}</pre><pre class="body">${escapeHtml(
            u.response.body
          )}</pre>`
        : ''
    }
    ${tests || scriptErrs ? `<h3>Tests</h3><ul class="tests">${tests}${scriptErrs}</ul>` : ''}
    ${findingsBlock(u)}
  </div>
</details>`
  }
}

/**
 * Passive security findings of a unit (`--findings`). Never affects the unit's
 * pass/fail class nor the "only failures" filter; an empty result states the
 * rules applied, never a verdict.
 */
function findingsBlock(u: RequestUnit): string {
  const f = u.findings
  if (!f) return ''
  if ('evaluationFailed' in f) {
    return `<h3>Security findings</h3><p class="muted">Findings could not be evaluated for this request.</p>`
  }
  const tls =
    f.tls === 'unavailable'
      ? `<p class="muted">TLS details not available for this connection.</p>`
      : ''
  if (f.items.length === 0) {
    return `<h3>Security findings</h3><p class="muted">No findings from the rules applied (${f.rulesApplied}).</p>${tls}`
  }
  const rows = f.items
    .map((item) => {
      const m = findingMessage(item.ruleId)
      const evidence = Object.entries(item.evidence)
        .map(([k, v]) => `${escapeHtml(k)}: <code>${escapeHtml(v)}</code>`)
        .join(', ')
      return `<li><span class="sev sev-${item.severity}">${item.severity}</span> <strong>${escapeHtml(
        item.title
      )}</strong>${evidence ? ` <span class="muted">(${evidence})</span>` : ''}${
        m.rationale ? `<div class="muted">${escapeHtml(m.rationale)}</div>` : ''
      }${m.reference ? `<div class="muted">Reference: ${escapeHtml(m.reference)}</div>` : ''}</li>`
    })
    .join('')
  return `<h3>Security findings</h3><ul class="findings">${rows}</ul>${tls}`
}

function headerBlock(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
    .join('\n')
}

const STYLE = `
:root{--bg:#0f1117;--fg:#e6e6e6;--muted:#8b8f9a;--card:#1a1d27;--good:#34d399;--bad:#f87171;--accent:#818cf8}
html[data-theme=light]{--bg:#f7f7fb;--fg:#1a1d27;--muted:#5a5f6b;--card:#fff;--good:#059669;--bad:#dc2626;--accent:#4f46e5}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 12px}h3{margin:12px 0 4px;font-size:13px;color:var(--muted)}
.meta{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 12px}.meta dt{color:var(--muted);font-size:11px}.meta dd{margin:0;font-weight:600}
.controls button{background:var(--card);color:var(--fg);border:1px solid var(--muted);border-radius:6px;padding:6px 10px;cursor:pointer;margin-right:8px}
.cards{display:flex;gap:12px;margin:16px 0}.card{background:var(--card);border-radius:8px;padding:12px 16px;display:flex;flex-direction:column;min-width:120px}
.card .n{font-size:22px;font-weight:700}.card.good .n{color:var(--good)}.card.bad .n{color:var(--bad)}
.unit{background:var(--card);border-radius:8px;margin:8px 0;padding:8px 12px}
.unit summary{cursor:pointer;display:flex;gap:8px;align-items:center}
.badge{font-weight:700;padding:2px 6px;border-radius:4px;font-size:11px;background:var(--accent);color:#fff}.badge.bad{background:var(--bad)}
.status{font-weight:600}.muted{color:var(--muted)}
pre{background:rgba(127,127,127,.12);padding:8px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.tests{list-style:none;padding:0}.tests .pass{color:var(--good)}.tests .fail{color:var(--bad)}
.findings{list-style:none;padding:0}.findings li{margin:4px 0}
.sev{font-weight:700;padding:1px 6px;border-radius:4px;font-size:10px;text-transform:uppercase;background:rgba(127,127,127,.25)}
.sev-high{background:var(--bad);color:#fff}.sev-medium{background:#d97706;color:#fff}
body.only-failures .unit-pass{display:none}
`

const SCRIPT = `
document.getElementById('theme').onclick=function(){var h=document.documentElement;h.dataset.theme=h.dataset.theme==='dark'?'light':'dark'};
document.getElementById('filter').onclick=function(){document.body.classList.toggle('only-failures')};
`
