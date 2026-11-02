import * as React from 'react'

import { cn } from '@renderer/lib/utils'

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'muted'

const VARIANTS: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'border-border text-foreground',
  muted: 'border-transparent bg-muted text-muted-foreground'
}

function Badge({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'span'> & { variant?: BadgeVariant }) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
        VARIANTS[variant],
        className
      )}
      {...props}
    />
  )
}

export { Badge }
