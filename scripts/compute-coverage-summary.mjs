#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const summaryPath = resolve('coverage/coverage-summary.json')
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))

const PROJECTS = ['main', 'shared', 'renderer']
const METRICS = ['statements', 'branches', 'functions', 'lines']

function makeBucket() {
  const b = {}
  for (const m of METRICS) b[m] = { covered: 0, total: 0 }
  return b
}

const groups = Object.fromEntries(PROJECTS.map((p) => [p, makeBucket()]))
const lowCoverageFiles = []

for (const [key, val] of Object.entries(summary)) {
  if (key === 'total') continue
  const norm = key.replace(/\\/g, '/')
  let proj = null
  if (norm.includes('/src/main/')) proj = 'main'
  else if (norm.includes('/src/shared/')) proj = 'shared'
  else if (norm.includes('/src/renderer/')) proj = 'renderer'
  if (!proj) continue
  for (const m of METRICS) {
    groups[proj][m].covered += val[m].covered
    groups[proj][m].total += val[m].total
  }
  if (val.lines.pct < 50 && val.lines.total > 0) {
    lowCoverageFiles.push({
      file: norm.split('/').slice(-4).join('/'),
      project: proj,
      lines: val.lines.pct,
      branches: val.branches.pct,
      functions: val.functions.pct
    })
  }
}

function pct(b) {
  return b.total === 0 ? 0 : (100 * b.covered) / b.total
}

const result = {
  generatedAt: new Date().toISOString(),
  projects: {}
}
for (const p of PROJECTS) {
  result.projects[p] = {}
  for (const m of METRICS) {
    result.projects[p][m] = Number(pct(groups[p][m]).toFixed(2))
    result.projects[p][m + 'Covered'] = groups[p][m].covered
    result.projects[p][m + 'Total'] = groups[p][m].total
  }
}
result.projects.total = {}
for (const m of METRICS) {
  result.projects.total[m] = Number(summary.total[m].pct.toFixed(2))
  result.projects.total[m + 'Covered'] = summary.total[m].covered
  result.projects.total[m + 'Total'] = summary.total[m].total
}
result.lowCoverageFiles = lowCoverageFiles.sort(
  (a, b) => a.lines - b.lines || a.file.localeCompare(b.file)
)

console.log(JSON.stringify(result, null, 2))
