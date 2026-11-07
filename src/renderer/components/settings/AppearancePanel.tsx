import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useAppearanceStore } from '../../stores/appearance'
import { useThemeStore } from '../../stores/theme'
import { generatePalette } from '../../../shared/palette/generate'
import { findPreset } from '../../../shared/palette/presets'
import {
  CUSTOM_ID,
  ORIGINAL_ID,
  customizeFrom,
  paramsOf,
  selectPalette,
  setCustomParams
} from '../../../shared/palette/preferences'
import type {
  AppearancePalettes,
  CustomPaletteParams,
  PaletteMode,
  PaletteTokens,
  Theme
} from '../../../shared/types'
import { ModeSelector } from './appearance/ModeSelector'
import { PaletteCards, type ChooseVia } from './appearance/PaletteCards'
import { CustomControls, type ControlKey } from './appearance/CustomControls'

/** The override map a mode's choice stands for (`null` = Original). */
function tokensFor(prefs: AppearancePalettes, mode: PaletteMode): PaletteTokens | null {
  const pref = prefs[mode]
  if (pref.selected === ORIGINAL_ID) return null
  return generatePalette(mode, paramsOf(mode, pref))
}

function presetName(mode: PaletteMode, id: string): string {
  if (id === ORIGINAL_ID) return 'settings.appearance.presets.original'
  return findPreset(mode, id)?.nameKey ?? 'settings.appearance.presets.custom'
}

/**
 * Settings → Appearance (requirement *Dynamic color themes* §6.1–§6.7).
 *
 * Every change applies to the whole window at once and is saved as it is made:
 * a click saves now, a drag on release, keyboard steps after a short pause.
 * The Light / Dark sub-tab chooses which palette is edited; picking the mode
 * that is not on screen previews it on the whole window. *Revert changes*
 * returns everything to how it was when Settings opened.
 */
export function AppearancePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const theme = useThemeStore((s) => s.theme)
  const resolved = useThemeStore((s) => s.resolvedTheme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const setPreviewTheme = useThemeStore((s) => s.setPreviewTheme)

  const prefs = useAppearanceStore((s) => s.prefs)
  const saveError = useAppearanceStore((s) => s.saveError)
  const dragging = useAppearanceStore((s) => s.dragging)
  const canRevert = useAppearanceStore((s) => s.canRevert(theme))
  const store = useAppearanceStore.getState

  // The sub-tab opens on the mode on screen, so opening Settings changes nothing.
  const [mode, setMode] = useState<PaletteMode>(() => resolved)
  const followResolved = useRef(false)
  const [announcement, setAnnouncement] = useState('')

  // Live control values during a drag or a run of keyboard steps.
  const [live, setLive] = useState<CustomPaletteParams | null>(null)
  const draggingRef = useRef(false)
  const cancelledRef = useRef(false)

  useEffect(() => {
    setPreviewTheme(mode !== resolved ? mode : null)
  }, [mode, resolved, setPreviewTheme])
  useEffect(() => () => setPreviewTheme(null), [setPreviewTheme])

  useEffect(() => {
    if (followResolved.current) {
      followResolved.current = false
      setMode(resolved)
    }
  }, [resolved])

  // A drag cancelled from outside (Escape) drops the live values.
  useEffect(() => {
    if (!dragging && draggingRef.current) {
      draggingRef.current = false
      cancelledRef.current = true
      setLive(null)
    }
  }, [dragging])

  // Once a save lands (or the stored values move), the live values have served their turn.
  useEffect(() => {
    if (!draggingRef.current) setLive(null)
  }, [prefs])

  const pref = prefs[mode]
  const isCustom = pref.selected === CUSTOM_ID
  const params = live ?? pref.custom ?? paramsOf(mode, pref)

  const forcedColors = useMemo(
    () => typeof matchMedia === 'function' && matchMedia('(forced-colors: active)').matches,
    []
  )

  const chooseTheme = (next: Theme): void => {
    setTheme(next)
    if (next === 'light' || next === 'dark') setMode(next)
    else {
      setMode(resolved)
      followResolved.current = true
    }
  }

  const chooseMode = (next: PaletteMode): void => {
    void store().flush()
    setLive(null)
    setMode(next)
  }

  const apply = (next: AppearancePalettes, via: ChooseVia): void => {
    store().preview(mode, tokensFor(next, mode))
    if (via === 'keyboard') store().scheduleCommit(next)
    else void store().commit(next)
  }

  const choose = (id: string, via: ChooseVia): void => apply(selectPalette(prefs, mode, id), via)

  const customize = (): void => apply(customizeFrom(prefs, mode, pref.selected), 'pointer')

  const onDragStart = (): void => {
    cancelledRef.current = false
    draggingRef.current = true
    store().beginDrag(mode)
  }

  const onChange = (key: ControlKey, value: number): void => {
    if (cancelledRef.current) return
    const next = { ...params, [key]: value }
    setLive(next)
    store().preview(mode, generatePalette(mode, next))
  }

  const onCommit = (key: ControlKey, value: number): void => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    const next = setCustomParams(prefs, mode, { ...params, [key]: value })
    if (draggingRef.current) {
      draggingRef.current = false
      void store().endDrag(next)
    } else {
      store().scheduleCommit(next)
    }
  }

  const revert = async (): Promise<void> => {
    setLive(null)
    await store().revert()
    const snapshotTheme = useThemeStore.getState().theme
    if (snapshotTheme === 'light' || snapshotTheme === 'dark') setMode(snapshotTheme)
    setAnnouncement(t('settings.appearance.reverted'))
  }

  const modeLabel = (m: PaletteMode): string => t(`settings.appearance.mode.${m}`)

  return (
    <div className="space-y-5 px-4 py-4">
      <section className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t('settings.appearance.mode.label')}
        </p>
        <ModeSelector value={theme} onChange={chooseTheme} />
      </section>

      <section className="space-y-3">
        <div>
          <p className="text-xs font-medium text-foreground">
            {t('settings.appearance.colorThemes')}
          </p>
          <p className="text-xs text-muted-foreground">{t('settings.appearance.savedAsYouGo')}</p>
        </div>

        {forcedColors && (
          <p className="rounded-md border border-border-default px-3 py-2 text-xs text-foreground">
            {t('settings.appearance.forcedColors')}
          </p>
        )}

        <div role="tablist" className="flex border-b border-border">
          {(['light', 'dark'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              aria-label={modeLabel(m)}
              onClick={() => chooseMode(m)}
              className={cn(
                'mr-4 py-1.5 text-xs font-medium transition-colors',
                mode === m
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {modeLabel(m)}
            </button>
          ))}
        </div>

        {mode !== resolved && (
          <p className="text-xs text-muted-foreground">
            {t('settings.appearance.previewNote', {
              mode: modeLabel(mode),
              current: modeLabel(resolved)
            })}
          </p>
        )}

        <PaletteCards mode={mode} pref={pref} onChoose={choose} />

        {isCustom ? (
          <CustomControls
            mode={mode}
            params={params}
            onDragStart={onDragStart}
            onChange={onChange}
            onCommit={onCommit}
            onBlur={() => void store().flush()}
          />
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t('settings.appearance.customHint')}</p>
            <button
              type="button"
              onClick={customize}
              className="shrink-0 rounded border border-border-default bg-background px-2.5 py-1 text-xs text-foreground hover:bg-accent"
            >
              {t('settings.appearance.customize', { name: t(presetName(mode, pref.selected)) })}
            </button>
          </div>
        )}

        {saveError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger-text"
          >
            <span>{t('settings.appearance.saveError')}</span>
            <button
              type="button"
              onClick={() => void store().retry()}
              className="shrink-0 rounded border border-border-default bg-background px-2 py-0.5 text-foreground hover:bg-accent"
            >
              {t('settings.appearance.retry')}
            </button>
          </div>
        )}
      </section>

      <div className="flex items-center justify-end border-t border-border pt-3">
        <button
          type="button"
          disabled={!canRevert}
          onClick={() => void revert()}
          className="rounded border border-border-default bg-background px-2.5 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('settings.appearance.revert')}
        </button>
      </div>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}

export default AppearancePanel
