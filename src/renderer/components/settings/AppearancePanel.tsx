import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useAppearanceStore, type AppearanceScope } from '../../stores/appearance'
import { useThemeStore } from '../../stores/theme'
import { generatePalette } from '../../../shared/palette/generate'
import { ORIGINAL_PALETTES } from '../../../shared/palette/original'
import { findPreset } from '../../../shared/palette/presets'
import {
  CUSTOM_ID,
  DEFAULT_WORKSPACE_APPEARANCE,
  INHERIT_ID,
  ORIGINAL_ID,
  customizeFrom,
  paramsOf,
  selectPalette,
  setCustomParams,
  type InheritContext
} from '../../../shared/palette/preferences'
import type {
  AppearancePalettes,
  CustomPaletteParams,
  ModePalettePreference,
  PaletteMode,
  PaletteTokens,
  Theme
} from '../../../shared/types'
import { ModeSelector } from './appearance/ModeSelector'
import { PaletteCards, type ChooseVia, type InheritOption } from './appearance/PaletteCards'
import { CustomControls, type ControlKey } from './appearance/CustomControls'

/** The override map a mode's own choice stands for (`null` = Original). */
function ownTokens(mode: PaletteMode, pref: ModePalettePreference): PaletteTokens | null {
  if (pref.selected === ORIGINAL_ID) return null
  return generatePalette(mode, paramsOf(mode, pref))
}

/** Name key of the palette a preference stands for. */
function nameKeyOf(mode: PaletteMode, pref: ModePalettePreference): string {
  if (pref.selected === ORIGINAL_ID) return 'settings.appearance.presets.original'
  if (pref.selected === CUSTOM_ID) return 'settings.appearance.presets.custom'
  return findPreset(mode, pref.selected)?.nameKey ?? 'settings.appearance.presets.original'
}

/**
 * Settings → Appearance (requirement *Dynamic color themes* §6.1–§6.7) and, with
 * `scope="workspace"`, Workspace Settings → Appearance (requirement *Workspace
 * color palettes* §6.2–§6.4).
 *
 * Every change applies to the whole window at once and is saved as it is made,
 * at the level being edited: a click saves now, a drag on release, keyboard
 * steps after a short pause. The Light / Dark sub-tab chooses which palette is
 * edited; picking the mode that is not on screen previews it on the whole
 * window. *Revert changes* returns the edited level to how it was when its
 * dialog opened.
 *
 * At user level, when the open workspace overrides the mode being edited, the
 * window shows the user's palette for it (with a note) while that sub-tab is
 * open. At workspace level there is no mode selector — the mode is the user's —
 * and each mode can inherit the user's palette.
 */
export function AppearancePanel({
  scope = 'user'
}: {
  scope?: AppearanceScope
}): React.JSX.Element {
  const { t } = useTranslation()
  const theme = useThemeStore((s) => s.theme)
  const resolved = useThemeStore((s) => s.resolvedTheme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const setPreviewTheme = useThemeStore((s) => s.setPreviewTheme)

  const prefs = useAppearanceStore((s) => s.prefs)
  const workspace = useAppearanceStore((s) => s.workspace)
  const saveError = useAppearanceStore((s) => s.saveError)
  const dragging = useAppearanceStore((s) => s.dragging)
  const canRevert = useAppearanceStore((s) => s.canRevert(theme))
  const store = useAppearanceStore.getState

  const isWorkspace = scope === 'workspace'
  const edited: AppearancePalettes = isWorkspace
    ? (workspace ?? DEFAULT_WORKSPACE_APPEARANCE)
    : prefs

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
  }, [prefs, workspace])

  const pref = edited[mode]
  const userPref = prefs[mode]
  const inheritCtx: InheritContext = isWorkspace ? { inherited: userPref } : {}
  const isCustom = pref.selected === CUSTOM_ID
  const params = live ?? pref.custom ?? paramsOf(mode, pref, inheritCtx.inherited)

  // User level: the open workspace overrides this mode, so the window shows the
  // user's palette for it while this sub-tab is open — what is being edited.
  const overridden = !isWorkspace && workspace !== null && workspace[mode].selected !== INHERIT_ID
  // …and whether it overrides either mode: then the note's place is kept on both
  // sub-tabs, so switching between them never moves the cards.
  const overridesEither =
    !isWorkspace &&
    workspace !== null &&
    (workspace.light.selected !== INHERIT_ID || workspace.dark.selected !== INHERIT_ID)
  useEffect(() => {
    if (isWorkspace) return
    store().setDisplayOverride(overridden ? { mode, tokens: ownTokens(mode, userPref) } : null)
  }, [isWorkspace, overridden, mode, userPref, store])
  useEffect(
    () => () => {
      if (!isWorkspace) store().setDisplayOverride(null)
    },
    [isWorkspace, store]
  )

  const inherit: InheritOption | undefined = useMemo(
    () =>
      isWorkspace
        ? {
            pref: userPref,
            nameKey: nameKeyOf(mode, userPref),
            tokens: ownTokens(mode, userPref) ?? ORIGINAL_PALETTES[mode]
          }
        : undefined,
    [isWorkspace, mode, userPref]
  )

  const forcedColors = useMemo(
    () => typeof matchMedia === 'function' && matchMedia('(forced-colors: active)').matches,
    []
  )

  /** What the window should show for `mode` after `next` is chosen at this level. */
  const tokensAfter = (next: AppearancePalettes): PaletteTokens | null => {
    const choice = next[mode]
    return choice.selected === INHERIT_ID ? ownTokens(mode, userPref) : ownTokens(mode, choice)
  }

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
    store().preview(mode, tokensAfter(next))
    if (via === 'keyboard') store().scheduleCommit(next, scope)
    else void store().commit(next, scope)
  }

  const choose = (id: string, via: ChooseVia): void =>
    apply(selectPalette(edited, mode, id, inheritCtx), via)

  const customize = (): void =>
    apply(customizeFrom(edited, mode, pref.selected, inheritCtx), 'pointer')

  const onDragStart = (): void => {
    cancelledRef.current = false
    draggingRef.current = true
    store().beginDrag(mode, scope)
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
    const next = setCustomParams(edited, mode, { ...params, [key]: value })
    if (draggingRef.current) {
      draggingRef.current = false
      void store().endDrag(next, scope)
    } else {
      store().scheduleCommit(next, scope)
    }
  }

  const revert = async (): Promise<void> => {
    setLive(null)
    await store().revert()
    const snapshotTheme = useThemeStore.getState().theme
    if (!isWorkspace && (snapshotTheme === 'light' || snapshotTheme === 'dark'))
      setMode(snapshotTheme)
    setAnnouncement(t('settings.appearance.reverted'))
  }

  const modeLabel = (m: PaletteMode): string => t(`settings.appearance.mode.${m}`)
  const otherMode: PaletteMode = mode === 'light' ? 'dark' : 'light'
  const previewing = mode !== resolved
  const customizeName =
    pref.selected === INHERIT_ID ? t(nameKeyOf(mode, userPref)) : t(nameKeyOf(mode, pref))

  return (
    <div className="space-y-5 px-4 py-4">
      {!isWorkspace && (
        <section className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t('settings.appearance.mode.label')}
          </p>
          <ModeSelector value={theme} onChange={chooseTheme} />
        </section>
      )}

      <section className="space-y-3">
        <div>
          <p className="text-xs font-medium text-foreground">
            {t('settings.appearance.colorThemes')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              isWorkspace
                ? 'settings.appearance.workspaceSavedAsYouGo'
                : 'settings.appearance.savedAsYouGo'
            )}
          </p>
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

        {/*
          The notes above the cards keep their place on both sub-tabs: where a
          note does not apply, the other sub-tab's note holds its height, unseen
          and unheard. Switching Light / Dark never moves the cards.
        */}
        <p
          data-slot="appearance-preview-note"
          aria-hidden={previewing ? undefined : true}
          className={cn('text-xs text-muted-foreground', !previewing && 'invisible')}
        >
          {t('settings.appearance.previewNote', {
            mode: modeLabel(previewing ? mode : otherMode),
            current: modeLabel(resolved)
          })}
        </p>

        {overridesEither && (
          <p
            data-slot="appearance-override-note"
            aria-hidden={overridden ? undefined : true}
            className={cn(
              'rounded-md border border-border-default px-3 py-2 text-xs text-foreground',
              !overridden && 'invisible'
            )}
          >
            {t('settings.appearance.workspaceOverride', {
              mode: modeLabel(overridden ? mode : otherMode)
            })}
          </p>
        )}

        <PaletteCards mode={mode} pref={pref} inherit={inherit} onChoose={choose} />

        {/* Room for the four Custom controls either way, so Customize moves nothing below. */}
        <div data-slot="appearance-custom-area" className="min-h-[8.25rem]">
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
                {t('settings.appearance.customize', { name: customizeName })}
              </button>
            </div>
          )}
        </div>

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
