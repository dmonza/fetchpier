import { useTranslation } from 'react-i18next'
import { ExternalLink, PanelBottomClose, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useActivityPanelStore } from '../../stores/activityPanel'
import { RequestsActivityTab } from './RequestsActivityTab'
import type { ActivityTabId } from '../../../shared/types'

interface ActivityPanelProps {
  /** 'docked' renders the in-window overlay; 'popout' renders inside the popout BrowserWindow. */
  mode: 'docked' | 'popout'
}

const TABS: ActivityTabId[] = ['requests']

export function ActivityPanel({ mode }: ActivityPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = useActivityPanelStore((s) => s.activeTab)
  const setActiveTab = useActivityPanelStore((s) => s.setActiveTab)
  const popout = useActivityPanelStore((s) => s.popout)
  const requestDock = useActivityPanelStore((s) => s.requestDock)
  const close = useActivityPanelStore((s) => s.close)

  const isPopout = mode === 'popout'

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* Top chrome: tab strip + actions */}
      <div className="flex h-9 shrink-0 items-center border-b border-border bg-muted/40">
        <div className="flex h-full items-center">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'h-full px-3 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors',
                activeTab === tab
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(`activityPanel.tabs.${tab}`)}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-0.5 pr-1">
          {!isPopout && (
            <button
              type="button"
              onClick={() => {
                void popout()
              }}
              title={t('activityPanel.popout.tooltip')}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          )}
          {isPopout && (
            <button
              type="button"
              onClick={() => {
                void requestDock()
              }}
              title={t('activityPanel.dock.tooltip')}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <PanelBottomClose className="h-3.5 w-3.5" />
            </button>
          )}
          {!isPopout && (
            <button
              type="button"
              onClick={close}
              title={t('activityPanel.close.tooltip')}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Active tab content */}
      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === 'requests' && <RequestsActivityTab />}
      </div>
    </div>
  )
}
