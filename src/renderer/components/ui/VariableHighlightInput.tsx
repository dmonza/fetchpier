/**
 * VariableHighlightInput
 *
 * A drop-in replacement for <input> that:
 * 1. Renders {{variable}} tokens in green (resolved) or red (unresolved) using a
 *    mirror-div overlay technique — the real input has transparent text while the
 *    colored mirror shows beneath it.
 * 2. Shows an autocomplete dropdown when the user types `{{` and environment
 *    variables are available.
 * 3. In `secret` mode it masks the value with dots, briefly revealing the last
 *    typed character (modern password-field affordance). The value stays visible
 *    only when it is *exactly* a single `{{variable}}` reference (the name is not
 *    the secret); any other value — including a literal beginning with `{` — is
 *    masked whole.
 *
 * Props:
 *   className     → applied to the outer container div (visual shell: border, bg, h-*)
 *   inputClassName → applied to the inner <input> (font: px-*, text-*, placeholder:*)
 *   variables     → Record<name, value> from the active environment (omit for a
 *                   pure-literal secret: then `secret` masks everything)
 *   secret        → mask the value (dots + brief last-char reveal)
 */

import React, {
  useRef,
  useState,
  useMemo,
  useEffect,
  useCallback,
  useImperativeHandle,
  useLayoutEffect
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { KeyRound, Dices } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  buildVariableSuggestions,
  filterVariableSuggestions,
  getOpenVariableQuery,
  computeVariableCompletion,
  isCompleteVariableReference,
  type VariableSuggestion
} from '../../lib/variables-editing'
import { isDynamicVariableName } from '@shared/lib/dynamic-variables'

// ── Segment parsing ─────────────────────────────────────────────────────────

interface Segment {
  text: string
  type: 'text' | 'var-found' | 'var-missing' | 'var-dynamic'
}

const VARIABLE_RE = /\{\{([^{}]+)\}\}/g

/** Stable empty map so the "variables provided?" check and memo refs stay sane. */
const EMPTY_VARIABLES: Record<string, string | null> = {}
/** Masking glyph for `secret` mode (monospace bullet aligns with the input caret). */
const MASK_CHAR = '•'
/** REQ-0089: how long the most recently typed character stays visible before masking. */
const REVEAL_LAST_CHAR_MS = 700
/** REQ-0094: max height of the portaled suggestion overlay (matches `max-h-48` = 12rem). */
const SUGGEST_MAX_HEIGHT = 192
/** REQ-0094: gap in px between the field and the suggestion overlay. */
const SUGGEST_GAP = 2

function parseSegments(text: string, variables: Record<string, string | null>): Segment[] {
  const segments: Segment[] = []
  let lastIndex = 0
  VARIABLE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = VARIABLE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), type: 'text' })
    }
    const name = match[1].trim()
    // REQ-0087: a recognized dynamic token renders in a third state, distinct
    // from resolved (env value exists) and missing (unknown name).
    const type: Segment['type'] = isDynamicVariableName(name)
      ? 'var-dynamic'
      : Object.prototype.hasOwnProperty.call(variables, name)
        ? 'var-found'
        : 'var-missing'
    segments.push({ text: match[0], type })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), type: 'text' })
  }
  return segments
}

// ── Component ────────────────────────────────────────────────────────────────

export interface VariableHighlightInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value'
> {
  value: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  /**
   * Active environment variables (the unified shape-classified map) used for
   * `{{...}}` highlighting and the `{{`-triggered suggestion. All declared names
   * are offered by name; secret values (`enc:`/`null`) carry no value preview.
   */
  variables?: Record<string, string | null>
  /** Classes for the outer container div (border, bg, height, rounded, flex …) */
  className?: string
  /** Classes for the inner <input> (px-*, text-*, placeholder:*, outline …) */
  inputClassName?: string
  /**
   * Mask the value as a secret. Content shows as dots with the last typed
   * character briefly revealed; the value stays visible only when it is *exactly*
   * a single `{{variable}}` reference — and only when `variables` is supplied (a
   * pure secret with no `variables` masks everything, references included).
   */
  secret?: boolean
}

export const VariableHighlightInput = React.forwardRef<
  HTMLInputElement,
  VariableHighlightInputProps
>(function VariableHighlightInput(
  {
    value,
    onChange,
    variables,
    className,
    inputClassName,
    readOnly,
    disabled,
    type = 'text',
    secret = false,
    onKeyDown,
    onFocus,
    onBlur,
    ...rest
  },
  forwardedRef
) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Expose the inner input via forwardRef
  useImperativeHandle(forwardedRef, () => inputRef.current!, [])

  const [suggestions, setSuggestions] = useState<VariableSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  // REQ-0089: global index of the most recently typed character to reveal
  // briefly. Only meaningful in `secret` mode.
  const [revealIndex, setRevealIndex] = useState<number | null>(null)
  // REQ-0094: fixed-position rect for the portaled suggestion overlay. Recomputed
  // when the overlay opens and while it stays open (scroll/resize). `null` until
  // the first measurement so the portal isn't rendered at a stale position.
  const [dropdownPos, setDropdownPos] = useState<{
    left: number
    top: number
    width: number
    placement: 'below' | 'above'
  } | null>(null)

  // A field is "variable-capable" when a variables map is supplied; pure
  // secrets (e.g. the proxy password) omit it and mask everything.
  const variableAware = variables !== undefined
  const vars = variables ?? EMPTY_VARIABLES

  const allSuggestions = useMemo(
    () => (secret && !variableAware ? [] : buildVariableSuggestions(vars)),
    [secret, variableAware, vars]
  )

  const segments = useMemo(() => parseSegments(value, vars), [value, vars])
  const hasVariables = segments.some((s) => s.type !== 'text')

  // A value that is *exactly* a single `{{variable}}` reference is not the secret
  // (the name is shown, never a value), so it stays visible; anything else in
  // secret mode is masked whole, with the last-typed character briefly revealed —
  // including a literal that begins with `{` and a reference with surrounding
  // literal text. This shares one predicate with the clear-text-literal warning.
  const showsReference = variableAware && isCompleteVariableReference(value)
  const maskAll = secret && !showsReference
  const maskedDisplay = useMemo(() => {
    if (!maskAll) return ''
    let out = ''
    for (let i = 0; i < value.length; i++) out += i === revealIndex ? value[i] : MASK_CHAR
    return out
  }, [maskAll, value, revealIndex])

  // Overlay is always on in secret mode (paints dots or a visible token);
  // otherwise only when there are variables to highlight on a non-password field.
  const useOverlay = secret || (hasVariables && type !== 'password')

  // Clean up the reveal timer on unmount.
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current)
    },
    []
  )

  // ── Scroll sync ──────────────────────────────────────────────────────────
  const syncScroll = useCallback(() => {
    if (inputRef.current && mirrorRef.current) {
      mirrorRef.current.scrollLeft = inputRef.current.scrollLeft
    }
  }, [])

  // ── Suggestion helpers ───────────────────────────────────────────────────
  const updateSuggestions = useCallback(
    (val: string, cursor: number) => {
      if (readOnly || disabled || allSuggestions.length === 0) {
        setShowSuggestions(false)
        return
      }
      const partial = getOpenVariableQuery(val.slice(0, cursor))
      if (partial !== null) {
        const filtered = filterVariableSuggestions(allSuggestions, partial)
        setSuggestions(filtered)
        setShowSuggestions(filtered.length > 0)
        setSelectedIdx(0)
      } else {
        setShowSuggestions(false)
        setSuggestions([])
      }
    },
    [readOnly, disabled, allSuggestions]
  )

  // REQ-0094: anchor the portaled overlay to the field's viewport rect. Opens
  // below the field; flips above when there isn't room below and there is more
  // room above, so the list stays on-screen.
  const updateDropdownPosition = useCallback(() => {
    const input = inputRef.current
    if (!input) return
    const rect = input.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const placement: 'below' | 'above' =
      spaceBelow < SUGGEST_MAX_HEIGHT && spaceAbove > spaceBelow ? 'above' : 'below'
    setDropdownPos({
      left: rect.left,
      top: placement === 'below' ? rect.bottom + SUGGEST_GAP : rect.top - SUGGEST_GAP,
      width: rect.width,
      placement
    })
  }, [])

  // Measure before paint when the overlay opens, and keep it anchored while open:
  // capture-phase `scroll` catches scrolling in any ancestor, `resize` catches
  // window changes. Listeners exist only while the overlay is shown.
  useLayoutEffect(() => {
    const open = showSuggestions && suggestions.length > 0 && !readOnly && !disabled
    if (!open) return
    updateDropdownPosition()
    const reanchor = (): void => updateDropdownPosition()
    window.addEventListener('scroll', reanchor, true)
    window.addEventListener('resize', reanchor)
    return () => {
      window.removeEventListener('scroll', reanchor, true)
      window.removeEventListener('resize', reanchor)
    }
  }, [showSuggestions, suggestions.length, readOnly, disabled, updateDropdownPosition])

  const selectSuggestion = useCallback(
    (varName: string) => {
      if (!inputRef.current) return
      const cursor = inputRef.current.selectionStart ?? value.length
      const before = value.slice(0, cursor)
      const after = value.slice(cursor)
      const match = /\{\{([^}]*)$/.exec(before)
      if (match) {
        const startPos = cursor - match[0].length
        // Idempotent close: consume any `}}` already present after the caret
        // so the result is exactly `{{name}}`, never doubled (REQ-0078 §6.2).
        const { insert, consume } = computeVariableCompletion(varName, after)
        const newValue = value.slice(0, startPos) + insert + after.slice(consume)
        onChange?.({ target: { value: newValue } } as React.ChangeEvent<HTMLInputElement>)
        const newCursor = startPos + insert.length // caret after the closing }}
        requestAnimationFrame(() => {
          if (inputRef.current) {
            inputRef.current.setSelectionRange(newCursor, newCursor)
            inputRef.current.focus()
          }
        })
      }
      setShowSuggestions(false)
      setSuggestions([])
    },
    [value, onChange]
  )

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      const target = e.target as Node
      // The overlay is portaled outside the container (REQ-0094), so a click
      // inside it would otherwise read as "outside" and close before selection.
      if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ── Event handlers ───────────────────────────────────────────────────────
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (secret) {
        const next = e.target.value
        // Reveal the just-typed character on insertion; clear on delete.
        if (next.length > value.length) {
          const caret = e.target.selectionStart ?? next.length
          setRevealIndex(caret - 1)
          if (revealTimer.current) clearTimeout(revealTimer.current)
          revealTimer.current = setTimeout(() => setRevealIndex(null), REVEAL_LAST_CHAR_MS)
        } else {
          if (revealTimer.current) clearTimeout(revealTimer.current)
          setRevealIndex(null)
        }
      }
      onChange?.(e)
      const cursor = e.target.selectionStart ?? e.target.value.length
      updateSuggestions(e.target.value, cursor)
    },
    [secret, value, onChange, updateSuggestions]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (showSuggestions && suggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedIdx((i) => Math.max(i - 1, 0))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          const chosen = suggestions[selectedIdx]
          if (chosen) {
            e.preventDefault()
            selectSuggestion(chosen.name)
            return
          }
        }
        if (e.key === 'Escape') {
          setShowSuggestions(false)
          return
        }
      }
      onKeyDown?.(e)
    },
    [showSuggestions, suggestions, selectedIdx, selectSuggestion, onKeyDown]
  )

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      updateSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length)
      onFocus?.(e)
    },
    [updateSuggestions, onFocus]
  )

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      if (secret) {
        // Don't leave a character revealed once focus leaves the field.
        if (revealTimer.current) clearTimeout(revealTimer.current)
        setRevealIndex(null)
      }
      // Delay to allow onMouseDown on suggestion buttons to fire first
      setTimeout(() => setShowSuggestions(false), 150)
      onBlur?.(e)
    },
    [secret, onBlur]
  )

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Mirror div — renders colored variable tokens beneath the input */}
      {useOverlay && (
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center overflow-hidden',
            'select-none whitespace-pre',
            inputClassName,
            secret && 'font-mono'
          )}
        >
          {maskAll ? (
            <span className="text-foreground">{maskedDisplay}</span>
          ) : (
            segments.map((seg, i) => (
              <span
                key={i}
                className={
                  seg.type === 'var-found'
                    ? 'text-var-resolved'
                    : seg.type === 'var-missing'
                      ? 'text-var-missing'
                      : seg.type === 'var-dynamic'
                        ? 'fp-var-dynamic-fg'
                        : 'text-foreground'
                }
              >
                {seg.text}
              </span>
            ))
          )}
        </div>
      )}

      {/* Input — transparent text when overlay is active so mirror shows through */}
      <input
        ref={inputRef}
        // Masked literal → native password (a11y); a visible variable → text.
        type={maskAll ? 'password' : secret ? 'text' : type}
        value={value}
        onChange={handleChange}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        readOnly={readOnly}
        disabled={disabled}
        className={cn(
          'relative z-[1] h-full w-full bg-transparent focus:outline-none',
          inputClassName,
          secret && 'font-mono',
          useOverlay && ['[color:transparent]', '[caret-color:var(--foreground)]'],
          // Show the selection as an indigo band only — never recolor the input's
          // own glyphs. In overlay mode the input text is transparent and the colored
          // text lives in the mirror beneath; painting the input's glyphs on selection
          // (text-foreground) would reveal them ~1px off the mirror's baseline, so the
          // selected text appears to jump. Keeping the glyphs transparent lets the band
          // highlight the (unmoved) mirror text through it.
          useOverlay && !maskAll && '[&::selection]:bg-primary/40'
        )}
        {...rest}
      />

      {/* Autocomplete dropdown — portaled to document.body and fixed-positioned so
            it escapes every ancestor's `overflow` clip and stacking context (panels,
            resizable split, modal dialogs) and always paints above all layers via
            `--z-variable-suggest` (REQ-0094). */}
      {showSuggestions &&
        suggestions.length > 0 &&
        !readOnly &&
        !disabled &&
        dropdownPos &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: 'fixed',
              left: dropdownPos.left,
              top: dropdownPos.top,
              width: dropdownPos.width,
              zIndex: 'var(--z-variable-suggest)',
              ...(dropdownPos.placement === 'above' ? { transform: 'translateY(-100%)' } : null)
            }}
            className="max-h-48 min-w-40 overflow-y-auto rounded-md border border-border bg-popover shadow-md"
          >
            {suggestions.map((suggestion, idx) => (
              <button
                key={suggestion.name}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectSuggestion(suggestion.name)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
                  idx === selectedIdx
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-muted-foreground">{'{{'}</span>
                  <span
                    className={suggestion.isDynamic ? 'fp-var-dynamic-fg' : 'text-var-resolved'}
                  >
                    {suggestion.name}
                  </span>
                  <span className="text-muted-foreground">{'}}'}</span>
                </span>
                {suggestion.isDynamic ? (
                  <Dices
                    className="fp-var-dynamic-fg h-3 w-3 shrink-0"
                    aria-label={t('request.variableSuggestion.dynamic')}
                  />
                ) : (
                  suggestion.isSecret && (
                    <KeyRound
                      className="h-3 w-3 shrink-0 text-muted-foreground"
                      aria-label={t('request.variableSuggestion.secret')}
                    />
                  )
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
})
