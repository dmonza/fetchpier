import * as React from 'react'

import { cn } from '@renderer/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs transition-colors outline-none',
        'file:border-0 file:bg-transparent file:text-xs placeholder:text-muted-foreground',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export { Input }
