import { useToastStore, type ToastMessage } from '../../stores/toast'
import { cn } from '@renderer/lib/utils'

const VARIANTS: Record<ToastMessage['type'], string> = {
  info: 'bg-card text-card-foreground border-border',
  success: 'bg-card text-card-foreground border-border',
  error: 'bg-destructive text-destructive-foreground border-destructive'
}

/**
 * Fixed bottom-right stack of currently active toasts. Each toast auto-dismisses
 * after its `durationMs` (managed by the store) and can be dismissed manually
 * by clicking it.
 */
export function ToastContainer(): React.JSX.Element {
  const messages = useToastStore((s) => s.messages)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col items-end gap-2">
      {messages.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={cn(
            'pointer-events-auto max-w-sm rounded-md border px-4 py-2 text-sm shadow-md',
            'transition-opacity hover:opacity-90',
            VARIANTS[t.type]
          )}
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
