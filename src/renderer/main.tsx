import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { applyPlatformTheme } from './lib/platform-theme'
import './assets/main.css'
import './i18n'

// Before the first render, not in an effect: an effect runs after React has
// already painted, which would show one frame in the wrong theme on top of a
// startup shell that painted the right one.
applyPlatformTheme()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
