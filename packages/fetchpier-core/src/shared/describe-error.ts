/**
 * Turning a thrown value into the reason the user reads.
 *
 * Every seam that reports a failed send used to do this by hand — `err instanceof
 * Error ? err.message : String(err)` — and that is exactly wrong for the failure
 * the runtime raises when *every* address of a multi-address host fails to
 * connect: it carries its detail in an `errors` list and leaves its own message
 * empty. The reason then travelled as `''`, and every consumer renders a reason
 * only when it is non-empty, so a refused connection to a dual-stack host (the
 * local hostname, on a default installation of all three platforms) rendered as
 * if the user had never pressed Send.
 *
 * Containment belongs to this operation rather than to each call site: the
 * project already learned that lesson when a malformed escape aborted a whole
 * parse because one of four seams guarded its own call and the others did not.
 */

/** The reason reported when a failure carries no usable detail at all. */
export const NO_REPORTED_REASON = 'Failed without a reported reason'

/** Separator between the causes of an aggregated failure. */
const CAUSE_SEPARATOR = '; '

/**
 * How deep the cause chain is followed. An aggregate can nest, and a
 * self-referential one would recurse forever; this bounds the walk without
 * capping how many causes are reported at any level (the address list is the
 * diagnostic — see the requirement's open question on capping).
 */
const MAX_CAUSE_DEPTH = 3

/**
 * Describes any thrown value as a non-empty, single-line reason.
 *
 * Resolution order, most specific first: the failure's own message, then the
 * described causes it aggregates (in the order they were attempted, neither
 * sorted nor deduplicated — for a connection failure that order *is* the
 * diagnostic), then its machine-readable code, then {@link NO_REPORTED_REASON}.
 *
 * A failure that already carries a message is returned verbatim: the runtime's
 * own sentence beats anything composed from its parts, and every existing reason
 * stays byte-identical.
 *
 * Never throws and never returns an empty string, for any input — including
 * values that are not errors, and values that throw when read.
 */
export function describeError(err: unknown): string {
  return describe(err, 0) || NO_REPORTED_REASON
}

/** Returns a described reason, or `''` when this value carries no detail. */
function describe(err: unknown, depth: number): string {
  if (err == null) return ''

  try {
    if (err instanceof Error) {
      const message = err.message.trim()
      if (message) return message

      if (depth < MAX_CAUSE_DEPTH) {
        const { errors } = err as { errors?: unknown }
        if (Array.isArray(errors)) {
          const described = errors
            .map((cause) => describe(cause, depth + 1))
            .filter((reason) => reason.length > 0)
          if (described.length > 0) return described.join(CAUSE_SEPARATOR)
        }
      }

      const { code } = err as { code?: unknown }
      if (typeof code === 'string' && code.trim()) return code.trim()
      return ''
    }

    if (typeof err === 'string') return err.trim()

    // Anything else: only worth reporting if it stringifies to something a
    // reader can act on. `[object Object]` names nothing, and a symbol throws.
    const text = String(err).trim()
    return text === '[object Object]' ? '' : text
  } catch {
    // Reading the value threw (a hostile getter, a symbol). The caller still
    // gets a reason — that is the whole point of this operation.
    return ''
  }
}
