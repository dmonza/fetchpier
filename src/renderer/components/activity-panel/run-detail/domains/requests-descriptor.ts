// The requests-domain descriptor for `RunDetail` (REQ-0069).
//
// This is one of the two places (the other being REQ-0073's mock descriptor)
// where directive names are allowed to appear as strings — the descriptor is
// precisely the seam that protects `RunDetail` itself from learning about any
// domain's `.http` shape. REQ-0073 will supply its own descriptor next to
// this one; the component code is unchanged.
//
// Sections (in order): Metadata · Request · Response (with JSON Format
// toggle) · Scripts.

import type { ActivityLogFile } from '../../../../../shared/lib/activity-log'
import type { RunDetailDescriptor } from '../types'

function findDirective(file: ActivityLogFile, key: string): string | null {
  for (const it of file.header) {
    if (it.kind === 'directive' && it.key === key) return it.value
  }
  return null
}

function formatLocalTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return iso
  }
}

function pickDurationMs(file: ActivityLogFile): string | null {
  const v = findDirective(file, 'duration-ms')
  if (v === null) return null
  return `${v} ms`
}

function pickStatusFromResponseRaw(file: ActivityLogFile): string | null {
  const firstLine = (file.responseRaw.split(/\r?\n/, 1)[0] ?? '').trim()
  const m = firstLine.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/)
  if (!m) return null
  const code = m[1]
  const text = (m[2] ?? '').trim()
  return text ? `${code} ${text}` : code
}

function pickLocalTimestamp(file: ActivityLogFile): string | null {
  const v = findDirective(file, 'timestamp')
  return v === null ? null : formatLocalTimestamp(v)
}

export const requestsRunDetailDescriptor: RunDetailDescriptor = {
  sections: [
    {
      kind: 'metadata',
      includeSettingsBlock: true,
      rows: [
        {
          id: 'source-file',
          labelKey: 'history.expansion.metadata.sourceFile',
          variant: 'path-with-open',
          pick: (f) => findDirective(f, 'source-file')
        },
        {
          id: 'run-id',
          labelKey: 'history.expansion.metadata.runId',
          pick: (f) => findDirective(f, 'run-id')
        },
        {
          id: 'request-id',
          labelKey: 'history.expansion.metadata.requestId',
          pick: (f) => findDirective(f, 'request-id')
        },
        {
          id: 'duration',
          labelKey: 'history.expansion.metadata.duration',
          pick: pickDurationMs
        },
        {
          id: 'status',
          labelKey: 'history.expansion.metadata.status',
          pick: pickStatusFromResponseRaw
        },
        {
          id: 'remote-ip',
          labelKey: 'history.expansion.metadata.remoteIp',
          pick: (f) => findDirective(f, 'remote-ip')
        },
        {
          id: 'timestamp',
          labelKey: 'history.expansion.metadata.timestamp',
          pick: pickLocalTimestamp
        }
      ]
    },
    { kind: 'rawHttp', which: 'request' },
    { kind: 'rawHttp', which: 'response', jsonFormatToggle: true },
    { kind: 'scripts' }
  ]
}
