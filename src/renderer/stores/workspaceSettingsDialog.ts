import { create } from 'zustand'

/** Sections of the Workspace Settings dialog. */
export type WorkspaceSettingsSection = 'http' | 'security' | 'certificates' | 'appearance'

interface WorkspaceSettingsDialogState {
  open: boolean
  /** The section shown; kept across close/reopen like the dialog always did. */
  tab: WorkspaceSettingsSection
  setOpen: (open: boolean) => void
  setTab: (tab: WorkspaceSettingsSection) => void
  /** Open the dialog on a given section (e.g. the Security tab's "Open workspace settings"). */
  openAt: (tab: WorkspaceSettingsSection) => void
}

/**
 * Open state of the Workspace Settings dialog, shared so a surface outside the
 * sidebar (the response viewer's Security tab) can open it on a section.
 */
export const useWorkspaceSettingsDialogStore = create<WorkspaceSettingsDialogState>()((set) => ({
  open: false,
  tab: 'http',
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
  openAt: (tab) => set({ open: true, tab })
}))
