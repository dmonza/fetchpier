/**
 * Request instances — shared, pure helpers.
 *
 * An "instance" is a variant `.http` file that clones a parent request and is
 * grouped under it in the sidebar. Its filename carries a fixed double-extension
 * marker:
 *
 *   <parent-stem>.<instance-name>.instance.http
 *
 * e.g. `login.happy-path.instance.http` is the `happy-path` instance of the
 * request `login.http`. The `.instance.http` suffix is the unambiguous marker —
 * the parent–child relationship is never inferred from a common prefix alone.
 *
 * This module is the single source of truth for the naming rules, consumed by
 * the core tree reader (grouping) and the renderer (display + rename). Keep it
 * free of Node imports: the renderer imports it directly and must never pull a
 * Node built-in across the bridge.
 */

/** The fixed double-extension marker that identifies an instance file. */
export const INSTANCE_SUFFIX = '.instance.http'

/** Plain `.http` extension of a regular request file. */
export const HTTP_SUFFIX = '.http'

/**
 * Allowed characters for an instance name (one filename segment, no dots /
 * slashes / spaces). Used by both the renderer (inline-input validation) and
 * the main process (`fs:createInstance` enforcement).
 */
export const INSTANCE_NAME_RE = /^[a-zA-Z0-9_-]+$/

/** Whether `name` is an instance file (`*.instance.http`). */
export function isInstanceFileName(name: string): boolean {
  return name.length > INSTANCE_SUFFIX.length && name.endsWith(INSTANCE_SUFFIX)
}

/** Whether `instanceName` passes the instance-name character rules. */
export function isValidInstanceName(instanceName: string): boolean {
  return INSTANCE_NAME_RE.test(instanceName)
}

/** Build an instance filename from a parent stem and an instance name. */
export function instanceFileName(parentStem: string, instanceName: string): string {
  return `${parentStem}.${instanceName}${INSTANCE_SUFFIX}`
}

/**
 * Split an instance filename into its parent stem and instance name, given the
 * set of regular-request stems that live in the same directory.
 *
 * Returns the split for the **longest** prefix that is a known regular stem
 * (so `login.v2.happy-path.instance.http` binds to `login.v2.http` when it
 * exists, falling back to `login.http`). Returns `null` when no sibling parent
 * exists — the caller renders the file as an orphan instance.
 */
export function splitInstanceName(
  fileName: string,
  regularStems: ReadonlySet<string>
): { parentStem: string; instanceName: string } | null {
  if (!isInstanceFileName(fileName)) return null
  const core = fileName.slice(0, -INSTANCE_SUFFIX.length)
  // Longest matching prefix = rightmost dot whose prefix is a known stem.
  for (let i = core.length - 1; i > 0; i--) {
    if (core[i] !== '.') continue
    const prefix = core.slice(0, i)
    if (regularStems.has(prefix)) {
      return { parentStem: prefix, instanceName: core.slice(i + 1) }
    }
  }
  return null
}

/**
 * Display name for an instance node in the sidebar. When the parent stem is
 * known (grouped child) it is the `<instance-name>` segment; for an orphan
 * (no parent in the directory) it is the whole core before `.instance.http`.
 */
export function instanceDisplayName(fileName: string, regularStems: ReadonlySet<string>): string {
  const split = splitInstanceName(fileName, regularStems)
  if (split) return split.instanceName
  return fileName.slice(0, -INSTANCE_SUFFIX.length)
}
