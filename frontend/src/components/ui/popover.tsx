'use client'

import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'
import { floatingSurface, popperMotion } from './styles'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export const PopoverClose = PopoverPrimitive.Close

type PopoverContentProps = React.ComponentProps<typeof PopoverPrimitive.Content> & {
  /** Content padding. Menus of items use "menu" (4px); forms use the default 16px. */
  padding?: 'default' | 'menu' | 'none'
}

/** Centred on its trigger unless the caller lines it up with an edge (`align="end"` for a button at the right). */

export function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  padding = 'default',
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          floatingSurface,
          popperMotion,
          'w-72 max-w-[calc(100vw-24px)]',
          padding === 'default' && 'p-4',
          padding === 'menu' && 'p-1',
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
