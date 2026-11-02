import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import es from './locales/es.json'

const STORAGE_KEY = 'language'
const SUPPORTED = ['en', 'es']

function getCachedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function setCachedLanguage(lang: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // ignore
  }
}

function normalizeLocale(locale: string): string {
  const base = locale.split('-')[0].toLowerCase()
  return SUPPORTED.includes(base) ? base : 'en'
}

// Boot: use localStorage cache for synchronous first render
const cachedLang = getCachedLanguage()
const initialLng = cachedLang && SUPPORTED.includes(cachedLang) ? cachedLang : 'en'

i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es }
  },
  lng: initialLng,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false
  }
})

// Push the translated close-fallback dialog strings (REQ-0104) to main on
// every language resolution — initial load and every subsequent change.
// Hooking `languageChanged` (rather than enumerating languages here) means a
// future added language needs no change to this file: whatever locale JSON
// is active gets pushed automatically.
function pushCloseDialogStrings(): void {
  window.api.window.setCloseDialogStrings({
    title: i18next.t('unresponsiveCloseDialog.title'),
    message: i18next.t('unresponsiveCloseDialog.message'),
    detail: i18next.t('unresponsiveCloseDialog.detail'),
    keepWaiting: i18next.t('unresponsiveCloseDialog.keepWaiting'),
    closeAnyway: i18next.t('unresponsiveCloseDialog.closeAnyway')
  })
}
pushCloseDialogStrings()
i18next.on('languageChanged', pushCloseDialogStrings)

// The application menu is built in main, which has no i18n runtime, so its
// vocabulary is pushed the same way — and on the same hook, so a future added
// language needs no change here either.
//
// This push is also the readiness signal: until it lands, main keeps every
// application item in the menu disabled. That is deliberate. The window is
// shown before the interface has mounted, and on macOS the menu bar is on
// screen for that whole interval; keeping it inert means the interval in which
// the labels are still main's bootstrap defaults is exactly the interval in
// which nothing in the menu can be selected (REQ menu coherence §6.3, §6.6).
function pushMenuLabels(): void {
  window.api.menu.setLabels({
    app: {
      about: i18next.t('menu.app.about'),
      checkUpdates: i18next.t('menu.app.checkUpdates'),
      services: i18next.t('menu.app.services'),
      hide: i18next.t('menu.app.hide'),
      hideOthers: i18next.t('menu.app.hideOthers'),
      unhide: i18next.t('menu.app.unhide'),
      quit: i18next.t('menu.app.quit')
    },
    file: {
      label: i18next.t('menu.file.label'),
      newRequest: i18next.t('menu.file.newRequest'),
      newCollection: i18next.t('menu.file.newCollection'),
      openWorkspace: i18next.t('menu.file.openWorkspace'),
      closeWorkspace: i18next.t('menu.file.closeWorkspace'),
      save: i18next.t('menu.file.save'),
      closeTab: i18next.t('menu.file.closeTab'),
      closeAllTabs: i18next.t('menu.file.closeAllTabs'),
      closeWindow: i18next.t('menu.file.closeWindow')
    },
    edit: {
      label: i18next.t('menu.edit.label'),
      undo: i18next.t('menu.edit.undo'),
      redo: i18next.t('menu.edit.redo'),
      cut: i18next.t('menu.edit.cut'),
      copy: i18next.t('menu.edit.copy'),
      paste: i18next.t('menu.edit.paste'),
      selectAll: i18next.t('menu.edit.selectAll')
    },
    request: {
      label: i18next.t('menu.request.label'),
      send: i18next.t('menu.request.send'),
      focusUrl: i18next.t('menu.request.focusUrl')
    },
    view: {
      label: i18next.t('menu.view.label'),
      commandPalette: i18next.t('menu.view.commandPalette'),
      toggleSidebar: i18next.t('menu.view.toggleSidebar'),
      toggleActivityPanel: i18next.t('menu.view.toggleActivityPanel'),
      toggleDevTools: i18next.t('menu.view.toggleDevTools'),
      zoomIn: i18next.t('menu.view.zoomIn'),
      zoomOut: i18next.t('menu.view.zoomOut'),
      resetZoom: i18next.t('menu.view.resetZoom')
    },
    window: {
      label: i18next.t('menu.window.label'),
      minimize: i18next.t('menu.window.minimize'),
      zoom: i18next.t('menu.window.zoom'),
      front: i18next.t('menu.window.front')
    }
  })
}
pushMenuLabels()
i18next.on('languageChanged', pushMenuLabels)

// After init, restore from appsettings.json (source of truth) if no local cache
if (!cachedLang) {
  window.api.appSettings
    .get()
    .then(({ language }) => {
      const normalized = normalizeLocale(language)
      if (normalized !== i18next.language) {
        i18next.changeLanguage(normalized)
        setCachedLanguage(normalized)
      }
    })
    .catch(() => {
      // Fall back to OS locale
      window.api.locale
        .get()
        .then((locale) => {
          const normalized = normalizeLocale(locale)
          if (normalized !== i18next.language) {
            i18next.changeLanguage(normalized)
          }
        })
        .catch(() => {})
    })
}

export function changeLanguage(lang: string): Promise<void> {
  return i18next.changeLanguage(lang).then(() => {
    setCachedLanguage(lang)
    window.api.appSettings.set({ language: lang }).catch(console.error)
  })
}

export { i18next }
export default i18next
