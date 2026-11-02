/**
 * Derivation of an environment's **folder name** from the display name the user
 * typed. Shared deliberately: `@fetchpier/core` needs it to validate and to
 * enforce uniqueness before touching the filesystem, and the renderer needs it to
 * pre-fill the duplicate input with a name that will commit cleanly. One
 * implementation, so the two cannot disagree about what a name maps to.
 *
 * The folder name is the environment's public handle — it is what version control
 * tracks and what a CLI run passes to `--env` — so the derivation is
 * deterministic, total, and idempotent (`derive(derive(x)) === derive(x)`).
 * Idempotence is load-bearing: the environment lister repairs a stored display
 * name that no longer matches its folder by writing the folder name into it, and
 * that repair must not re-trigger on the next read.
 */

/**
 * Maximum length of a derived folder name. Machine-local state lives two levels
 * below it (`<env>/.state/cookies.json`) and Windows' default path limit is
 * comparatively short, so an uncapped name plus a deep workspace path can produce
 * an unwritable cookie-jar path — a failure that would surface on the first send,
 * far from its cause. Capping moves the failure to naming time, where the message
 * is actionable.
 */
export const MAX_ENV_FOLDER_NAME = 48

/**
 * Turn the name the user typed into a filesystem-safe folder name:
 *
 * 1. Decompose accented characters and drop the combining marks (`Producción` →
 *    `Produccion`), so an accented name yields a readable handle instead of a
 *    mangled one.
 * 2. Lowercase.
 * 3. Replace every run of characters outside `a-z0-9` with a single hyphen.
 * 4. Trim leading and trailing hyphens.
 * 5. Cap at {@link MAX_ENV_FOLDER_NAME}, cutting at a hyphen boundary so no word
 *    is left half-written (a single word longer than the cap is hard-truncated).
 *
 * Returns `''` when nothing survives — the caller rejects that name rather than
 * inventing a folder on the user's behalf.
 */
export function deriveEnvFolderName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // strip the combining marks NFD just separated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (slug.length <= MAX_ENV_FOLDER_NAME) return slug

  const clipped = slug.slice(0, MAX_ENV_FOLDER_NAME)
  const lastBoundary = clipped.lastIndexOf('-')
  const capped = lastBoundary > 0 ? clipped.slice(0, lastBoundary) : clipped
  return capped.replace(/^-+|-+$/g, '')
}

/**
 * The first free `<name>-copy` name given the folders already `taken`, then
 * `<name>-copy-2`, `-copy-3`, … The typed name is what is returned (so the copy
 * of `Producción` is offered as `Producción-copy`), but the freeness test runs on
 * the *derived* folder, case-insensitively — the folder is the unit of
 * uniqueness, so a candidate whose folder is taken would be rejected on commit.
 */
export function firstFreeEnvCopyName(
  sourceName: string,
  takenFolders: ReadonlySet<string>
): string {
  const taken = new Set([...takenFolders].map((f) => f.toLowerCase()))
  const isFree = (candidate: string): boolean =>
    !taken.has(deriveEnvFolderName(candidate).toLowerCase())

  const first = `${sourceName}-copy`
  if (isFree(first)) return first
  let n = 2
  while (!isFree(`${sourceName}-copy-${n}`)) n++
  return `${sourceName}-copy-${n}`
}
