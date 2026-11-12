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
  const followActiveWorkspace = useWorkspaceStore((s) => s.followActiveWorkspace)

  useEffect(() => {
    document.title = t('activityPanel.popoutWindow.title')
  }, [t])

  // Bind to the workspace the main window has open and follow it: a pure read
  // of main's active workspace plus its open/switch/close announcements. Never
  // `loadLastWorkspace` — that restores (re-activates) the last-opened one,
  // even after the user closed it.
  useEffect(() => followActiveWorkspace(), [followActiveWorkspace])

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
