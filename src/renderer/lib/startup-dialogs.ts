import type { UpdatesSettings } from '../../shared/types'
import { shouldAutoOpenUpdates } from '../stores/appSettings'
import { OPEN_UPDATES_EVENT } from './events'

/**
 * Whether the About should be shown for `currentVersion`. A missing, empty, or
 * simply different stored version all count as a change — the comparison is a
 * plain string equality, so a downgrade shows the About too.
 */
export function shouldShowAboutForVersion(
  lastVersion: string | null | undefined,
  currentVersion: string
): boolean {
  return !lastVersion || lastVersion !== currentVersion
}

export interface StartupDialogsInput {
  lastVersion: string | null | undefined
  currentVersion: string
  updates: UpdatesSettings
  nowMs: number
}

export interface StartupDialogsDecision {
  showAbout: boolean
  showUpdates: boolean
  /** The update prompt was due but the About won; hold it until the flow ends. */
  postponeUpdates: boolean
}

/** The About wins a startup where both dialogs are due; the prompt is postponed. */
export function decideStartupDialogs(input: StartupDialogsInput): StartupDialogsDecision {
  const showAbout = shouldShowAboutForVersion(input.lastVersion, input.currentVersion)
  const updatesDue = shouldAutoOpenUpdates(input.updates, input.nowMs)
  return {
    showAbout,
    showUpdates: !showAbout && updatesDue,
    postponeUpdates: showAbout && updatesDue
  }
}

// ── About-flow coordinator ───────────────────────────────────────────────────
//
// The About, third-party-licenses, and updates dialogs are independent modals
// driven by DOM events; nothing else sequences them. This coordinator adds the
// single ordering rule the product needs: a postponed update prompt fires once
// the About flow — the About plus whatever the user opened from it — is fully
// closed, and never fires if the user reached the updates dialog on their own.
//
// Dialogs report open/close from their handlers (not from effects) because the
// handoff between two sibling modals must be observed in a deterministic order.

/** Dialogs that belong to the About flow. The updates dialog ends it, so it is not one. */
export type FlowDialog = 'about' | 'thirdPartyLicenses'

const openFlowDialogs = new Set<FlowDialog>()
let updatesCheckPending = false

export function postponeUpdatesUntilAboutFlowEnds(): void {
  updatesCheckPending = true
}

/** The user reached the updates dialog themselves — the postponed one is moot. */
export function cancelPostponedUpdatesCheck(): void {
  updatesCheckPending = false
}

export function notifyFlowDialogOpened(dialog: FlowDialog): void {
  openFlowDialogs.add(dialog)
}

export function notifyFlowDialogClosed(dialog: FlowDialog): void {
  openFlowDialogs.delete(dialog)
  if (!updatesCheckPending || openFlowDialogs.size > 0) return
  updatesCheckPending = false
  window.dispatchEvent(new CustomEvent(OPEN_UPDATES_EVENT))
}

/** Test-only: the coordinator is module state, so each case starts from zero. */
export function resetStartupDialogsForTest(): void {
  openFlowDialogs.clear()
  updatesCheckPending = false
}
