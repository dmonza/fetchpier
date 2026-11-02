import type { Tab, WorkspaceTree } from '../../../shared/types'
import { INSTANCE_SUFFIX, HTTP_SUFFIX } from '../../../shared/lib/request-instances'

/**
 * Open tabs whose backing file is affected by a tree operation on `node` —
 * the node itself, anything under it (a folder rename/move), or an **instance**
 * of it (REQ-0095). Used by the unsaved-edit guard so rename/move (menu or
 * drag-and-drop) never silently drops unsaved edits in an affected tab.
 *
 * Instances are sibling files named `<stem>.<name>.instance.http` (not nested
 * under the parent path), so a simple "under the path" check misses them — they
 * are matched explicitly.
 */
export function tabsAffectedBy(tabs: Tab[], node: WorkspaceTree): Tab[] {
  // For a request file node, its instances are siblings `<stem>.<name>.instance.http`.
  const instancePrefix =
    node.type === 'file' && node.path.endsWith(HTTP_SUFFIX)
      ? node.path.slice(0, -HTTP_SUFFIX.length) + '.'
      : null
  return tabs.filter((t) => {
    const fp = t.filePath
    if (fp == null) return false
    if (fp === node.path) return true
    if (fp.startsWith(node.path + '/') || fp.startsWith(node.path + '\\')) return true
    if (instancePrefix && fp.startsWith(instancePrefix) && fp.endsWith(INSTANCE_SUFFIX)) return true
    return false
  })
}
