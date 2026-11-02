import { useEffect, useState } from 'react'
import type { NameCheckInput } from '../../shared/types'
import { queryNameAvailability, type NameAvailability } from '../lib/name-availability'

export type { NameAvailability }

/**
 * IPC-backed inline name validation (REQ case-insensitive tree name
 * uniqueness): asks the core for a verdict on the settled input value and
 * renders the answer — the verdict reflects the real disk state, not the tree
 * snapshot. `null` input means "nothing to check" (empty/unchanged name).
 * Verdict semantics live in `lib/name-availability.ts`.
 */
export function useNameAvailability(input: NameCheckInput | null): NameAvailability {
  const [state, setState] = useState<NameAvailability>('idle')
  // Serialize for the effect dependency: callers build a fresh object per render.
  const key = input ? JSON.stringify(input) : null

  useEffect(() => {
    return queryNameAvailability(key ? (JSON.parse(key) as NameCheckInput) : null, setState)
  }, [key])

  return state
}
