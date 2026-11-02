/**
 * Startup dialog precedence: the About wins over the update prompt on a launch
 * where both are due, and the postponed prompt fires only once the whole About
 * flow (About plus anything opened from it) has closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatesSettings } from '../../shared/types'
import { OPEN_UPDATES_EVENT } from './events'
import {
  cancelPostponedUpdatesCheck,
  decideStartupDialogs,
  notifyFlowDialogClosed,
  notifyFlowDialogOpened,
  postponeUpdatesUntilAboutFlowEnds,
  resetStartupDialogsForTest,
  shouldShowAboutForVersion
} from './startup-dialogs'

const updatesDue: UpdatesSettings = {
  intervalDays: 15,
  lastCheckAt: null,
  autoCheckEnabled: true
}
const updatesNotDue: UpdatesSettings = {
  intervalDays: 15,
  lastCheckAt: new Date('2026-07-10T00:00:00Z').toISOString(),
  autoCheckEnabled: true
}
const NOW = Date.parse('2026-07-10T01:00:00Z')

describe('shouldShowAboutForVersion', () => {
  it.each([
    ['null (fresh install / pre-existing settings file)', null],
    ['an empty string', ''],
    ['a different version', '0.9.1']
  ])('returns true for %s', (_label, lastVersion) => {
    expect(shouldShowAboutForVersion(lastVersion, '0.9.2')).toBe(true)
  })

  it('returns false when the stored version matches the current one', () => {
    expect(shouldShowAboutForVersion('0.9.2', '0.9.2')).toBe(false)
  })

  it('treats a downgrade as a version change', () => {
    expect(shouldShowAboutForVersion('1.0.0', '0.9.2')).toBe(true)
  })
})

describe('decideStartupDialogs', () => {
  it('shows only the About and postpones the update prompt when both are due', () => {
    expect(
      decideStartupDialogs({
        lastVersion: null,
        currentVersion: '0.9.2',
        updates: updatesDue,
        nowMs: NOW
      })
    ).toEqual({ showAbout: true, showUpdates: false, postponeUpdates: true })
  })

  it('shows the About alone when the update prompt is not due', () => {
    expect(
      decideStartupDialogs({
        lastVersion: '0.9.1',
        currentVersion: '0.9.2',
        updates: updatesNotDue,
        nowMs: NOW
      })
    ).toEqual({ showAbout: true, showUpdates: false, postponeUpdates: false })
  })

  it('shows the update prompt when the About is not due', () => {
    expect(
      decideStartupDialogs({
        lastVersion: '0.9.2',
        currentVersion: '0.9.2',
        updates: updatesDue,
        nowMs: NOW
      })
    ).toEqual({ showAbout: false, showUpdates: true, postponeUpdates: false })
  })

  it('shows nothing when neither is due', () => {
    expect(
      decideStartupDialogs({
        lastVersion: '0.9.2',
        currentVersion: '0.9.2',
        updates: updatesNotDue,
        nowMs: NOW
      })
    ).toEqual({ showAbout: false, showUpdates: false, postponeUpdates: false })
  })

  it('never postpones a prompt that was not due', () => {
    expect(
      decideStartupDialogs({
        lastVersion: null,
        currentVersion: '0.9.2',
        updates: { ...updatesDue, autoCheckEnabled: false },
        nowMs: NOW
      })
    ).toEqual({ showAbout: true, showUpdates: false, postponeUpdates: false })
  })
})

describe('About-flow coordinator', () => {
  let fired: number

  beforeEach(() => {
    resetStartupDialogsForTest()
    fired = 0
    vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
      if (event.type === OPEN_UPDATES_EVENT) fired++
      return true
    })
  })

  it('fires the postponed prompt when the About closes directly', () => {
    postponeUpdatesUntilAboutFlowEnds()
    notifyFlowDialogOpened('about')
    expect(fired).toBe(0)
    notifyFlowDialogClosed('about')
    expect(fired).toBe(1)
  })

  it('does not fire while the flow hands off to the third-party dialog', () => {
    postponeUpdatesUntilAboutFlowEnds()
    notifyFlowDialogOpened('about')

    // About → Third-party: the incoming dialog registers before the outgoing
    // one leaves, so the flow set never momentarily empties.
    notifyFlowDialogOpened('thirdPartyLicenses')
    notifyFlowDialogClosed('about')
    expect(fired).toBe(0)

    notifyFlowDialogClosed('thirdPartyLicenses')
    expect(fired).toBe(1)
  })

  it('survives a Back round-trip to the About', () => {
    postponeUpdatesUntilAboutFlowEnds()
    notifyFlowDialogOpened('about')
    notifyFlowDialogOpened('thirdPartyLicenses')
    notifyFlowDialogClosed('about')

    // Back to About
    notifyFlowDialogOpened('about')
    notifyFlowDialogClosed('thirdPartyLicenses')
    expect(fired).toBe(0)

    notifyFlowDialogClosed('about')
    expect(fired).toBe(1)
  })

  it('cancels the postponed prompt when the user opens updates from the About', () => {
    postponeUpdatesUntilAboutFlowEnds()
    notifyFlowDialogOpened('about')
    cancelPostponedUpdatesCheck()
    notifyFlowDialogClosed('about')
    expect(fired).toBe(0)
  })

  it('fires at most once', () => {
    postponeUpdatesUntilAboutFlowEnds()
    notifyFlowDialogOpened('about')
    notifyFlowDialogClosed('about')
    notifyFlowDialogOpened('about')
    notifyFlowDialogClosed('about')
    expect(fired).toBe(1)
  })

  it('does nothing when no prompt was postponed', () => {
    notifyFlowDialogOpened('about')
    notifyFlowDialogClosed('about')
    expect(fired).toBe(0)
  })
})
