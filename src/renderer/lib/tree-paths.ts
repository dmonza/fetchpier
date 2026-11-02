import type { WorkspaceTree } from '../../shared/types'

/**
 * Every node path in the workspace tree (files, folders, and instance children),
 * flattened. Used to prune a stale tree selection and to detect open tabs whose
 * backing file was removed/moved externally (REQ open-tab-file-reconciliation).
 */
export function collectAllPaths(nodes: WorkspaceTree[], acc: string[] = []): string[] {
  for (const node of nodes) {
    acc.push(node.path)
    if (node.children) collectAllPaths(node.children, acc)
  }
  return acc
}
