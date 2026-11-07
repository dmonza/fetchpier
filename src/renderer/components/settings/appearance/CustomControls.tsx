import { useMemo } from 'react'
import { Slider } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { oklchToHex } from '../../../../shared/palette/color'
import { generatePalette } from '../../../../shared/palette/generate'
import type { CustomPaletteParams, PaletteMode } from '../../../../shared/types'

export type ControlKey = keyof CustomPaletteParams

const MAX: Record<ControlKey, number> = {
  hue: 360,
  intensity: 100,
  surfaceTint: 100,
  brightness: 100
}

/** Rough colour name for a perceptual hue, for the spoken slider value. */
function hueName(h: number): string {
  const names: Array<[number, string]> = [
    [15, 'pink'],
    [45, 'red'],
    [70, 'orange'],
    [100, 'yellow'],
    [130, 'lime'],
    [165, 'green'],
    [195, 'teal'],
    [225, 'cyan'],
    [255, 'blue'],
    [285, 'indigo'],
    [315, 'violet'],
    [345, 'purple'],
    [361, 'pink']
  ]
  return names.find(([upTo]) => h < upTo)![1]
}

function gradient(stops: string[]): string {
  return `linear-gradient(to right, ${stops.join(', ')})`
}

/**
 * The four Custom controls. Each shows its value, works with the keyboard
 * (arrows, Page Up/Down and Shift for larger steps, Home/End for the ends) and
 * announces a value with meaning. The parent decides what a change and a
 * commit do (live draft vs. save).
 */
export function CustomControls({
  mode,
  params,
  onDragStart,
  onChange,
  onCommit,
  onBlur
}: {
  mode: PaletteMode
  params: CustomPaletteParams
  onDragStart: () => void
  onChange: (key: ControlKey, value: number) => void
  onCommit: (key: ControlKey, value: number) => void
  onBlur: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  const tracks = useMemo(() => {
    const at = (patch: Partial<CustomPaletteParams>): ReturnType<typeof generatePalette> =>
      generatePalette(mode, { ...params, ...patch })
    const hues = Array.from({ length: 13 }, (_, i) => oklchToHex({ l: 0.68, c: 0.14, h: i * 30 }))
    return {
      hue: gradient(hues),
      intensity: gradient([at({ intensity: 0 }).primary, at({ intensity: 100 }).primary]),
      surfaceTint: gradient([
        at({ surfaceTint: 0 })['surface-3'],
        at({ surfaceTint: 100 })['surface-3']
      ]),
      // Light: 0 is the dimmest, 100 the whitest. Dark: 0 the least dark, 100 the deepest.
      brightness: gradient([at({ brightness: 0 }).background, at({ brightness: 100 }).background])
    }
  }, [mode, params])

  const labelKey: Record<ControlKey, string> = {
    hue: 'settings.appearance.controls.hue',
    intensity: 'settings.appearance.controls.intensity',
    surfaceTint: 'settings.appearance.controls.surfaceTint',
    brightness:
      mode === 'light'
        ? 'settings.appearance.controls.brightness'
        : 'settings.appearance.controls.darkness'
  }

  const valueText = (key: ControlKey, v: number): string => {
    if (key === 'hue') {
      return t('settings.appearance.valueText.hue', {
        value: v,
        name: t(`settings.appearance.hueNames.${hueName(v)}`)
      })
    }
    if ((key === 'intensity' || key === 'surfaceTint') && v === 0) {
      return t('settings.appearance.valueText.neutral', { value: v })
    }
    return String(v)
  }

  const keys: ControlKey[] = ['hue', 'intensity', 'surfaceTint', 'brightness']

  return (
    <div className="space-y-3">
      {keys.map((key) => {
        const value = params[key]
        const label = t(labelKey[key])
        return (
          <div key={key} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <Slider.Root
              className="relative flex h-6 w-full touch-none select-none items-center"
              min={0}
              max={MAX[key]}
              step={1}
              value={[value]}
              onPointerDown={onDragStart}
              onValueChange={([v]) => onChange(key, v)}
              onValueCommit={([v]) => onCommit(key, v)}
              onBlur={onBlur}
            >
              <Slider.Track
                className="relative h-2 grow rounded-full border border-border"
                style={{ backgroundImage: tracks[key] }}
              >
                <Slider.Range className="absolute h-full rounded-full" />
              </Slider.Track>
              <Slider.Thumb
                aria-label={label}
                aria-valuetext={valueText(key, value)}
                className="block h-5 w-5 rounded-full border-2 border-foreground bg-background shadow-soft"
              />
            </Slider.Root>
            <span className="text-right text-xs tabular-nums text-foreground">
              {key === 'hue' ? `${value}°` : value}
            </span>
          </div>
        )
      })}
      {params.intensity === 0 && params.surfaceTint === 0 && (
        <p className="text-xs text-muted-foreground">{t('settings.appearance.hueNoEffect')}</p>
      )}
    </div>
  )
}
