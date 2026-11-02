#!/usr/bin/env node
/* Query coverage-summary.json for specific files. Usage: node scripts/query-coverage.mjs <substring>... */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const summary = JSON.parse(readFileSync(resolve('coverage/coverage-summary.json'), 'utf8'))

const patterns = process.argv.slice(2)
if (patterns.length === 0) {
  console.error('usage: node scripts/query-coverage.mjs <pattern>...')
  process.exit(1)
}

const rows = []
for (const [key, val] of Object.entries(summary)) {
  if (key === 'total') continue
  const norm = key.replace(/\\/g, '/')
  if (!patterns.some((p) => norm.includes(p))) continue
  rows.push({
    file: norm.replace(/^.*\/src\//, 'src/'),
    lines: val.lines.pct,
    branches: val.branches.pct,
    functions: val.functions.pct,
    statements: val.statements.pct,
    uncoveredLines: `${val.lines.total - val.lines.covered}/${val.lines.total}`
  })
}

rows.sort((a, b) => a.lines - b.lines)
console.log('file'.padEnd(60), 'lines%'.padStart(8), 'br%'.padStart(8), 'fn%'.padStart(8), 'uncov')
for (const r of rows) {
  console.log(
    r.file.padEnd(60),
    String(r.lines).padStart(8),
    String(r.branches).padStart(8),
    String(r.functions).padStart(8),
    r.uncoveredLines
  )
}
