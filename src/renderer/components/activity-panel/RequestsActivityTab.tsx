import { HistoryList } from './HistoryList'

interface RequestsActivityTabProps {
  /** Where the panel is rendered; the popout routes row actions to its owner. */
  mode: 'docked' | 'popout'
}

export function RequestsActivityTab({ mode }: RequestsActivityTabProps): React.JSX.Element {
  return <HistoryList variant="panel" mode={mode} />
}
