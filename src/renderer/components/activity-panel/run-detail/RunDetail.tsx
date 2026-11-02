// Shared, domain-agnostic run-detail expansion component (REQ-0069).
//
// Renders the sections declared by `descriptor` in order. The component
// contains no directive-name strings — all knowledge of how to read a
// directive lives in the descriptor's `pick(file)` callbacks. This is what
// lets REQ-0073 reuse the same component for mock runs with a different
// descriptor (different Metadata rows, three sections, no Scripts).

import { MetadataSection } from './sections/MetadataSection'
import { RawHttpSection } from './sections/RawHttpSection'
import { ScriptsSection, shouldRenderScripts } from './sections/ScriptsSection'
import type { ActivityLogFile } from '../../../../shared/lib/activity-log'
import type { RunDetailDescriptor } from './types'

export interface RunDetailProps {
  file: ActivityLogFile
  descriptor: RunDetailDescriptor
  /**
   * Called when the user clicks the "Open file" affordance on a Metadata row
   * declared with `variant: 'path-with-open'`. Receives the value that the
   * row's `pick(file)` returned. The host decides what "open" means.
   */
  onOpenSourceFile?: (path: string) => void
}

export function RunDetail({
  file,
  descriptor,
  onOpenSourceFile
}: RunDetailProps): React.JSX.Element {
  return (
    <div className="border-t border-border bg-muted/30">
      {descriptor.sections.map((spec, i) => {
        switch (spec.kind) {
          case 'metadata':
            return (
              <MetadataSection
                key={`metadata-${i}`}
                file={file}
                spec={spec}
                onOpenSourceFile={onOpenSourceFile}
              />
            )
          case 'rawHttp':
            return <RawHttpSection key={`rawHttp-${spec.which}-${i}`} file={file} spec={spec} />
          case 'scripts':
            if (!shouldRenderScripts(file)) return null
            return <ScriptsSection key={`scripts-${i}`} file={file} spec={spec} />
          default: {
            const _exhaustive: never = spec
            void _exhaustive
            return null
          }
        }
      })}
    </div>
  )
}
