import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceSettingsDialogStore } from './workspaceSettingsDialog'

const state = (): ReturnType<typeof useWorkspaceSettingsDialogStore.getState> =>
  useWorkspaceSettingsDialogStore.getState()

beforeEach(() => {
  useWorkspaceSettingsDialogStore.setState({ open: false, tab: 'http' })
})

describe('workspaceSettingsDialog store', () => {
  it('starts closed on the HTTP section', () => {
    expect(state()).toMatchObject({ open: false, tab: 'http' })
  })

  it('openAt opens the dialog on the requested section', () => {
    state().openAt('security')
    expect(state()).toMatchObject({ open: true, tab: 'security' })
  })

  it('setOpen keeps the last section, as reopening the dialog always has', () => {
    state().setTab('certificates')
    state().setOpen(true)
    expect(state()).toMatchObject({ open: true, tab: 'certificates' })
    state().setOpen(false)
    expect(state()).toMatchObject({ open: false, tab: 'certificates' })
  })
})
