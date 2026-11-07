import type * as React from 'react'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { useAppearanceStore } from '../../stores/appearance'

/**
 * The layout both settings dialogs share. One fixed size for every tab, capped
 * to the window — a dialog whose height followed its content re-centred on
 * every tab switch and moved the tab strip under the pointer. The title, the
 * tab strip and the footer stay put; only the selected panel scrolls.
 */
export interface SettingsDialogShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  tabs: ReadonlyArray<{ value: string; label: string }>
  value: string
  onValueChange: (value: string) => void
  /**
   * The user is judging colours on the app behind (the Appearance tab): no
   * tint over it, a stronger edge so the dialog still stands apart, and a click
   * on the app means "let me look", not "dismiss".
   */
  judging: boolean
  footer?: React.ReactNode
  /** The panels — `SettingsTabPanel`s, plus anything that renders nothing. */
  children: React.ReactNode
}

export function SettingsDialogShell({
  open,
  onOpenChange,
  title,
  description,
  tabs,
  value,
  onValueChange,
  judging,
  footer,
  children
}: SettingsDialogShellProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'h-[min(40rem,calc(100dvh-4rem))] w-[calc(100vw-2rem)] max-w-2xl gap-0 overflow-hidden p-0',
          judging && 'border-border-strong shadow-soft-lg'
        )}
        overlayClassName={judging ? 'bg-transparent' : undefined}
        onInteractOutside={(e) => {
          if (judging) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          // Escape during a drag puts the control back and keeps the dialog open.
          if (useAppearanceStore.getState().dragging) {
            e.preventDefault()
            useAppearanceStore.getState().cancelDrag()
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-10">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <Tabs value={value} onValueChange={onValueChange} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="w-full shrink-0 justify-start overflow-x-auto px-1">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="shrink-0 px-3">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {children}
        </Tabs>

        {footer && (
          <div className="flex shrink-0 flex-row items-center justify-between gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A tab's panel: the dialog's only scrolling region. Radix makes it focusable,
 * so the ring shows where keyboard scrolling applies; the stable gutter keeps
 * the content from shifting sideways when a scrollbar appears.
 */
export function SettingsTabPanel({
  value,
  children
}: {
  value: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TabsContent
      value={value}
      className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {children}
    </TabsContent>
  )
}
