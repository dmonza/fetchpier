import React from 'react'
import ReactDOM from 'react-dom/client'
import { ActivityPanelPopoutApp } from './components/activity-panel/ActivityPanelPopoutApp'
import { applyPlatformTheme } from './lib/platform-theme'
import './assets/main.css'
import './i18n'

// Same reason as the main entry: the theme has to be on `<html>` before the
// first render, so this window agrees with the main one from its first frame.
applyPlatformTheme()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ActivityPanelPopoutApp />
  </React.StrictMode>
)
