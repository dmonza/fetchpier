import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityPanel } from './ActivityPanel'
import { PopoutTitleBar } from './PopoutTitleBar'
import { ThemeProvider } from '../ThemeProvider'
import { TextSelectionMenu } from '../text-menu/TextSelectionMenu'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * Root component for the popout BrowserWindow. Wraps the same <ActivityPanel/>
 * the docked host uses, but with no sidebar / no main tab bar / no editor —
 * just the activity content laid out edge-to-edge.
 */
export function ActivityPanelPopoutApp(): React.JSX.Element {
  const { t } = useTranslation()
  const loadLastWorkspace = useWorkspaceStore((s) => s.loadLastWorkspace)

  useEffect(() => {
    document.title = t('activityPanel.popoutWindow.title')
  }, [t])

  // Ensure the popout knows which workspace is active (so HistoryList can talk
  // to history.ipc with a workspacePath). The workspace.ipc handlers are
  // singletons keyed by the main process, so simply asking for "last opened"
  // returns the same path the main window holds.
  useEffect(() => {
    void loadLastWorkspace()
  }, [loadLastWorkspace])

  return (
    <ThemeProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <PopoutTitleBar />
        <ActivityPanel mode="popout" />
      </div>
      <TextSelectionMenu />
    </ThemeProvider>
  )
}
