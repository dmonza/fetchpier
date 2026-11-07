import { useMemo, useRef } from 'react'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import { generatePalette } from '../../../../shared/palette/generate'
import { ORIGINAL_PALETTES } from '../../../../shared/palette/original'
import { PALETTE_PRESETS } from '../../../../shared/palette/presets'
import {
  CUSTOM_ID,
  INHERIT_ID,
  ORIGINAL_ID,
  paramsOf
} from '../../../../shared/palette/preferences'
import type { ModePalettePreference, PaletteMode, PaletteTokens } from '../../../../shared/types'

export type ChooseVia = 'pointer' | 'keyboard'

interface Card {
  id: string
  nameKey: string
  /** A second line, e.g. the name of the palette an *Inherit* card stands for. */
  detailKey?: string
  tokens: PaletteTokens
}

/** The user's palette a workspace mode can inherit. */
export interface InheritOption {
  /** The user's preference for the mode (seeds Custom when the mode inherits). */
  pref: ModePalettePreference
  /** Name key of the user's palette for the mode. */
  nameKey: string
  /** Its colours, for the swatches. */
  tokens: PaletteTokens
}

const SWATCHES = ['canvas', 'surface-1', 'primary', 'foreground'] as const

/**
 * Original, the presets of the mode and Custom — preceded, at workspace level,
 * by *Inherit from user* — as one single-choice group with one keyboard stop.
 * Arrow keys move the selection, and every selection applies at once.
 * Selection shows as a ring and a check mark, never by colour alone.
 */
export function PaletteCards({
  mode,
  pref,
  inherit,
  onChoose
}: {
  mode: PaletteMode
  pref: ModePalettePreference
  inherit?: InheritOption
  onChoose: (id: string, via: ChooseVia) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const cards: Card[] = useMemo(() => {
    const presets = PALETTE_PRESETS.filter((p) => p.mode === mode).map((p) => ({
      id: p.id,
      nameKey: p.nameKey,
      tokens: generatePalette(mode, p.params)
    }))
    const customParams = pref.custom ?? paramsOf(mode, pref, inherit?.pref)
    return [
      ...(inherit
        ? [
            {
              id: INHERIT_ID,
              nameKey: 'settings.appearance.inheritFromUser',
              detailKey: inherit.nameKey,
              tokens: inherit.tokens
            }
          ]
        : []),
      {
        id: ORIGINAL_ID,
        nameKey: 'settings.appearance.presets.original',
        tokens: ORIGINAL_PALETTES[mode]
      },
      ...presets,
      {
        id: CUSTOM_ID,
        nameKey: 'settings.appearance.presets.custom',
        tokens: generatePalette(mode, customParams)
      }
    ]
  }, [mode, pref, inherit])

  const selectedIndex = Math.max(
    0,
    cards.findIndex((c) => c.id === pref.selected)
  )

  const move = (from: number, delta: number): void => {
    const next = (from + delta + cards.length) % cards.length
    refs.current[next]?.focus()
    onChoose(cards[next].id, 'keyboard')
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('settings.appearance.colorThemes')}
      className={cn('grid gap-2', cards.length > 5 ? 'grid-cols-3' : 'grid-cols-5')}
    >
      {cards.map((card, i) => {
        const checked = i === selectedIndex
        const firstUse = card.id === CUSTOM_ID && !pref.custom
        const name = t(card.nameKey)
        return (
          <button
            key={card.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={name}
            data-first-use={firstUse ? 'true' : undefined}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChoose(card.id, 'pointer')}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                move(i, 1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(i, -1)
              }
            }}
            className={cn(
              'relative flex min-h-[4.25rem] flex-col items-start justify-between gap-2 rounded-md border bg-background p-2 text-left text-xs transition-colors',
              firstUse ? 'border-dashed border-border-default' : 'border-border',
              checked
                ? 'ring-2 ring-ring ring-offset-1 ring-offset-background'
                : 'hover:border-border-strong'
            )}
          >
            <span className="flex gap-1" aria-hidden="true">
              {SWATCHES.map((s) => (
                <span
                  key={s}
                  className="h-3.5 w-3.5 rounded-full border border-border"
                  style={{ backgroundColor: card.tokens[s] }}
                />
              ))}
            </span>
            <span className="flex w-full items-center justify-between gap-1 font-medium text-foreground">
              <span className="min-w-0">
                <span className="block truncate">{name}</span>
                {card.detailKey && (
                  <span className="block truncate font-normal text-muted-foreground">
                    {t(card.detailKey)}
                  </span>
                )}
              </span>
              {checked && (
                <Check className="h-3.5 w-3.5 shrink-0 text-primary-text" aria-hidden="true" />
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
