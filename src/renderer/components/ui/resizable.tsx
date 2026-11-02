import * as ResizablePrimitive from 'react-resizable-panels'
import { GripVertical } from 'lucide-react'
import { cn } from '../../lib/utils'

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Group>): React.JSX.Element => (
  <ResizablePrimitive.Group className={cn('flex h-full w-full', className)} {...props} />
)

const ResizablePanel = ResizablePrimitive.Panel

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean
}): React.JSX.Element => (
  <ResizablePrimitive.Separator
    className={cn(
      // Separador vertical (grupo horizontal)
      'relative flex w-px items-center justify-center bg-border',
      'after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
      // Separador horizontal (grupo vertical) — aria-orientation="horizontal" lo pone la librería
      'aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full',
      'aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1',
      'aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2',
      'aria-[orientation=horizontal]:after:translate-x-0',
      '[&[aria-orientation=horizontal]>div]:rotate-90',
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-5 w-3.5 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-3 w-3" />
      </div>
    )}
  </ResizablePrimitive.Separator>
)

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
