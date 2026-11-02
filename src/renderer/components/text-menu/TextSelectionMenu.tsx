import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '../ui/dropdown-menu'
import {
  buildTextMenuModel,
  getEditableTarget,
  getSelectedText,
  menuItemsFor,
  copyText,
  cutFromTarget,
  pasteIntoTarget,
  type TextMenuItem,
  type TextMenuModel
} from './textMenuModel'

type ShownModel = Extract<TextMenuModel, { show: true }>

interface OpenState {
  x: number
  y: number
  model: ShownModel
  canPaste: boolean
}

// Snapshot of the field + selection taken when the menu opens, so the verb can
// restore focus/selection the menu stole before acting (REQ §11 risk).
interface Captured {
  target: HTMLElement
  isField: boolean
  selectedText: string
  selStart: number | null
  selEnd: number | null
  range: Range | null
}

/**
 * Global text-selection context menu (Copy / Cut / Paste). One instance is
 * mounted at each renderer root. A `document`-level `contextmenu` listener
 * decides whether to show the menu and yields to the app's own context menus
 * (which call `preventDefault()` when they open).
 */
export function TextSelectionMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<OpenState | null>(null)
  const capturedRef = useRef<Captured | null>(null)

  useEffect(() => {
    function onContextMenu(e: MouseEvent): void {
      // An app context menu (collection tree / tabs / activity rows) already
      // handled this right-click → stay out of its way.
      if (e.defaultPrevented) return

      const model = buildTextMenuModel(e.target)
      if (!model.show) return
      e.preventDefault()

      const editableTarget = getEditableTarget(e.target)
      const target = editableTarget ?? (e.target instanceof HTMLElement ? e.target : null)
      if (!target) return

      const isField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      const sel = window.getSelection()
      capturedRef.current = {
        target,
        isField,
        selectedText: getSelectedText(target),
        selStart: isField ? (target as HTMLInputElement).selectionStart : null,
        selEnd: isField ? (target as HTMLInputElement).selectionEnd : null,
        range: !isField && sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
      }

      setState({ x: e.clientX, y: e.clientY, model, canPaste: false })
      setOpen(true)

      // Paste enablement reflects whether the clipboard holds text. Only read it
      // for editable targets (read-only menus never offer Paste). A blocked read
      // leaves Paste disabled.
      if (model.editable) {
        navigator.clipboard
          .readText()
          .then((text) => setState((s) => (s ? { ...s, canPaste: text.length > 0 } : s)))
          .catch(() => setState((s) => (s ? { ...s, canPaste: false } : s)))
      }
    }

    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  const restoreSelection = useCallback(() => {
    const c = capturedRef.current
    if (!c) return
    if (c.isField) {
      const el = c.target as HTMLInputElement
      el.focus()
      if (c.selStart !== null && c.selEnd !== null) el.setSelectionRange(c.selStart, c.selEnd)
    } else if (c.range) {
      c.target.focus()
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(c.range)
    }
  }, [])

  const run = useCallback(
    (id: TextMenuItem['id']) => {
      const c = capturedRef.current
      if (!c) return
      if (id === 'copy') {
        void copyText(c.selectedText).catch(() => {})
        return
      }
      restoreSelection()
      if (id === 'cut') void cutFromTarget(c.target)
      else void pasteIntoTarget(c.target)
    },
    [restoreSelection]
  )

  const items = state ? menuItemsFor(state.model, state.canPaste) : []
  const labels: Record<TextMenuItem['id'], string> = {
    cut: t('textMenu.cut'),
    copy: t('textMenu.copy'),
    paste: t('textMenu.paste')
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: state?.x ?? 0,
            top: state?.y ?? 0,
            width: 0,
            height: 0
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        // On close, return focus to the field we acted on. Radix's default
        // focuses the trigger — here an invisible 0×0 span — which would leave
        // the right-clicked field (e.g. the tree's inline rename input)
        // unfocused, so a later click elsewhere fires no blur and the rename
        // never commits/cancels. Refocusing the field restores normal blur.
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          capturedRef.current?.target.focus()
        }}
      >
        {items.map((item) => (
          <DropdownMenuItem key={item.id} disabled={item.disabled} onSelect={() => run(item.id)}>
            {labels[item.id]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
