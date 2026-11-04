'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'
import { IconButton } from './icon-button'

export const Dialog = DialogPrimitive.Root
export const DialogClose = DialogPrimitive.Close

const SIZES = { sm: 'max-w-[440px]', md: 'max-w-[560px]', lg: 'max-w-[720px]' } as const

type DialogContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  size?: keyof typeof SIZES
  /** Hide the corner close button (confirm dialogs have their own Cancel). */
  hideClose?: boolean
}

export function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-overlay bg-overlay',
        'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
        className
      )}
      {...props}
    />
  )
}

/** Centered, 440 / 560 / 720 wide. Escape closes; focus is trapped and returned by Radix. */
export function DialogContent({
  className,
  children,
  size = 'md',
  hideClose,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-0 z-modal m-auto h-fit max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] overflow-y-auto',
          'rounded-card border border-border bg-surface p-6 shadow-float outline-none',
          'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
          SIZES[size],
          className
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close asChild>
            <IconButton
              label="Close"
              icon={<X />}
              size="sm"
              noTooltip
              className="absolute right-3.5 top-3.5"
            />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mb-5 flex flex-col gap-1.5 pr-8', className)} {...props} />
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-heading text-fg', className)} {...props} />
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-small text-fg-2', className)} {...props} />
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex flex-wrap justify-end gap-2', className)} {...props} />
}
