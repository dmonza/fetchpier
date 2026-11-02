import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'

import { cn } from '@renderer/lib/utils'

const Tabs = TabsPrimitive.Root

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex h-8 items-center gap-0 border-b border-border', className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'flex h-8 items-center px-4 text-xs text-muted-foreground transition-colors',
        'data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-foreground',
        'hover:text-foreground',
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('outline-none', className)} {...props} />
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
