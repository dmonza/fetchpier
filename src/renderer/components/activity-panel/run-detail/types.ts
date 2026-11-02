// Domain-agnostic contract for the shared run-detail expansion (REQ-0069).
//
// The component (`RunDetail`) renders sections declared by a
// `RunDetailDescriptor`. The descriptor is the only place that may know about
// directive names or domain-specific shapes — `RunDetail` itself sees only
// the parsed `ActivityLogFile` plus this descriptor, which is what lets
// REQ-0073 reuse the same component for mock runs with a different descriptor.

import type { ActivityLogFile } from '../../../../shared/lib/activity-log'

/**
 * One declarative row of the Metadata key/value table. Both the label and the
 * value extraction are pluggable; rows whose `pick(file)` returns `null` are
 * silently omitted (older runs, no scripts, etc.).
 */
export interface MetadataRowSpec {
  /** Stable key used for React reconciliation and test selectors. */
  id: string
  /** i18n key for the row label. */
  labelKey: string
  /** Read the value from the parsed file. Return `null` to omit the row. */
  pick: (file: ActivityLogFile) => string | null
  /**
   * Optional render variant. `default` is plain text; `path-with-open` renders
   * the value as a workspace-relative path with an "Open file" affordance that
   * calls `onOpenSourceFile(path)`.
   */
  variant?: 'default' | 'path-with-open'
}

export interface MetadataSectionSpec {
  kind: 'metadata'
  /** Optional i18n key overriding the default "Metadata" heading. */
  titleKey?: string
  rows: MetadataRowSpec[]
  /**
   * If `true`, also render one extra row per key of the parsed `@settings`
   * header block (REQ-0069 §6.2 — Settings are flat key/value entries in v1).
   */
  includeSettingsBlock?: boolean
}

export interface RawHttpSectionSpec {
  kind: 'rawHttp'
  /** Which raw payload to render. */
  which: 'request' | 'response'
  /** Optional i18n key overriding the default "Request" / "Response" heading. */
  titleKey?: string
  /**
   * If `true`, when the payload's `Content-Type` matches `application/json`
   * show a `[Format]/[Raw]` button that pretty-prints the body (only).
   */
  jsonFormatToggle?: boolean
}

export interface ScriptsSectionSpec {
  kind: 'scripts'
  titleKey?: string
}

export type SectionSpec = MetadataSectionSpec | RawHttpSectionSpec | ScriptsSectionSpec

export interface RunDetailDescriptor {
  /** Sections rendered in declared order. */
  sections: SectionSpec[]
}
