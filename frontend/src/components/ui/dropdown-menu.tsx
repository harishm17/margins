'use client'

import * as React from 'react'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import { CaretRight, Check } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'
import { KEY_HINT_HIDDEN } from './kbd'
import { floatingSurface, menuItem, popperMotion } from './styles'

export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuSub = MenuPrimitive.Sub
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

const content = cn(floatingSurface, popperMotion, 'min-w-[200px] p-1')

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={12}
        className={cn(content, 'max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

type ItemProps = React.ComponentProps<typeof MenuPrimitive.Item> & {
  /** Leading icon element: icon={<Gear />}. */
  icon?: React.ReactNode
  /** Shortcut hint, right aligned. */
  kbd?: string
  /** Anything after the label, e.g. a check mark. */
  trailing?: React.ReactNode
  destructive?: boolean
}

export function DropdownMenuItem({ className, icon, kbd, trailing, destructive, children, ...props }: ItemProps) {
  return (
    <MenuPrimitive.Item
      className={cn(
        menuItem,
        destructive && 'text-danger-soft-fg data-[highlighted]:bg-danger-soft [&>svg]:text-current',
        className
      )}
      {...props}
    >
      {icon ? <span className="inline-flex [&>svg]:size-4 [&>svg]:text-fg-3">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
      {kbd ? <span className={cn('ml-4 text-caption font-normal text-fg-3', KEY_HINT_HIDDEN)}>{kbd}</span> : null}
    </MenuPrimitive.Item>
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(menuItem, 'pr-8', className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <MenuPrimitive.ItemIndicator className="absolute right-2.5 inline-flex">
        <Check weight="bold" className="size-4 text-accent" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(menuItem, 'pr-8', className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <MenuPrimitive.ItemIndicator className="absolute right-2.5 inline-flex">
        <Check weight="bold" className="size-4 text-accent" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.CheckboxItem>
  )
}

export function DropdownMenuSubTrigger({
  className,
  icon,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.SubTrigger> & { icon?: React.ReactNode }) {
  return (
    <MenuPrimitive.SubTrigger
      className={cn(menuItem, 'data-[state=open]:bg-surface-2', className)}
      {...props}
    >
      {icon ? <span className="inline-flex [&>svg]:size-4 [&>svg]:text-fg-3">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <CaretRight className="size-3.5 text-fg-3" />
    </MenuPrimitive.SubTrigger>
  )
}

export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        sideOffset={6}
        alignOffset={-4}
        collisionPadding={12}
        className={cn(content, className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label className={cn('px-2.5 py-1.5 text-caption text-fg-3', className)} {...props} />
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}
