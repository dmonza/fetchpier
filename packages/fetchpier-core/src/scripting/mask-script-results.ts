/**
 * Secret masking of script output (CLI readiness for CI).
 *
 * Scripts read secrets as plaintext (HMAC signing etc.), so anything they print
 * — `fp.log` arguments, test names, assertion messages, a thrown error — can
 * carry a secret verbatim. This masks it once, inside the engine, before the
 * result reaches any consumer (desktop console and activity log, CLI terminal,
 * reports, history). Substring masking, like the echoed-response masking: a
 * script that *transforms* a secret can still produce output this cannot
 * recognize (the documented exception).
 */

import type { ScriptExecutionResult, ScriptResultsBundle } from '@shared/types'
import { secretLogMask } from '../secrets/markers'

/**
 * Build a substring mask over `valuesByName` (name → plaintext). Longer values
 * are replaced first so a secret containing another is masked whole. Empty
 * values are ignored — they would match between every character.
 */
export function createValueMask(valuesByName: Record<string, string>): (text: string) => string {
  const entries = Object.entries(valuesByName)
    .filter(([, v]) => v.length > 0)
    .sort(([, a], [, b]) => b.length - a.length)
  if (entries.length === 0) return (text) => text
  return (text) => {
    let out = text
    for (const [name, value] of entries) out = out.split(value).join(secretLogMask(name))
    return out
  }
}

/** Deep-map every string inside a cloned log payload (arrays and plain objects). */
function maskValue(value: unknown, mask: (s: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return mask(value)
  if (depth > 32 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => maskValue(v, mask, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[mask(k)] = maskValue(v, mask, depth + 1)
  }
  return out
}

function maskSection(
  section: ScriptExecutionResult | undefined,
  mask: (s: string) => string
): ScriptExecutionResult | undefined {
  if (!section) return undefined
  return {
    ...section,
    ...(section.error
      ? {
          error: {
            message: mask(section.error.message),
            ...(section.error.stack !== undefined ? { stack: mask(section.error.stack) } : {})
          }
        }
      : {}),
    logs: section.logs.map((l) => ({ ...l, args: l.args.map((a) => maskValue(a, mask)) })),
    testResults: section.testResults.map((t) => ({
      ...t,
      name: mask(t.name),
      ...(t.error !== undefined ? { error: mask(t.error) } : {})
    })),
    ...(section.environmentChanges
      ? {
          environmentChanges: {
            set: Object.fromEntries(
              Object.entries(section.environmentChanges.set).map(([k, v]) => [k, mask(v)])
            ),
            removed: [...section.environmentChanges.removed]
          }
        }
      : {})
  }
}

/** Mask a send's script results with `mask`, returning a new bundle. */
export function maskScriptResults(
  bundle: ScriptResultsBundle | undefined,
  mask: (s: string) => string
): ScriptResultsBundle | undefined {
  if (!bundle) return undefined
  const preRequest = maskSection(bundle.preRequest, mask)
  const postResponse = maskSection(bundle.postResponse, mask)
  return {
    ...(preRequest ? { preRequest } : {}),
    ...(postResponse ? { postResponse } : {})
  }
}
