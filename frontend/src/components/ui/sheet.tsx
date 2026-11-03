'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'
import { DialogOverlay } from './dialog'
import { IconButton } from './icon-button'

export const Sheet = DialogPrimitive.Root
export const SheetClose = DialogPrimitive.Close

type SheetContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Desktop edge. A right sheet becomes a bottom sheet on mobile; a left sheet stays left. */
  side?: 'right' | 'left'
  hideClose?: boolean
}

/** Pull the handle down to dismiss a bottom sheet. */
function DragHandle({ contentRef, onDismiss }: { contentRef: React.RefObject<HTMLElement | null>; onDismiss: () => void }) {
  const start = React.useRef<number | null>(null)

  const move = (event: React.PointerEvent) => {
    if (start.current === null || !contentRef.current) return
    const delta = Math.max(0, event.clientY - start.current)
    contentRef.current.style.transition = 'none'
    contentRef.current.style.transform = `translateY(${delta}px)`
  }
  const end = (event: React.PointerEvent) => {
    if (start.current === null || !contentRef.current) return
    const delta = event.clientY - start.current
    start.current = null
    contentRef.current.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)'
    contentRef.current.style.transform = ''
    if (delta > 80) onDismiss()
  }

  return (
    <div
      aria-hidden="true"
      className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center sm:hidden"
      onPointerDown={(event) => {
        start.current = event.clientY
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span className="h-1 w-9 rounded-full bg-border-strong" />
    </div>
  )
}

export function SheetContent({
  className,
  children,
  side = 'right',
  hideClose,
  ...props
}: SheetContentProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)

  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-modal flex flex-col bg-surface shadow-float outline-none',
          side === 'right' &&
            [
              'sm:inset-y-0 sm:right-0 sm:w-[440px] sm:max-w-full sm:border-l',
              'sm:data-[state=open]:animate-sheet-in-right sm:data-[state=closed]:animate-sheet-out-right',
              'max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[85dvh] max-sm:rounded-t-card max-sm:border-t',
              'max-sm:data-[state=open]:animate-sheet-in-bottom max-sm:data-[state=closed]:animate-sheet-out-bottom',
            ].join(' '),
          side === 'left' &&
            'inset-y-0 left-0 w-[288px] max-w-[88vw] border-r data-[state=open]:animate-sheet-in-left data-[state=closed]:animate-sheet-out-left',
          className
        )}
        {...props}
      >
        {side === 'right' ? (
          <DragHandle contentRef={ref} onDismiss={() => closeRef.current?.click()} />
        ) : null}
        <DialogPrimitive.Close ref={closeRef} className="sr-only" tabIndex={-1} aria-hidden="true" />
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close asChild>
            <IconButton
              label="Close"
              icon={<X />}
              size="sm"
              noTooltip
              className="absolute right-3 top-3"
            />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 border-b border-border px-5 py-4 pr-12', className)} {...props} />
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-heading text-fg', className)} {...props} />
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-small text-fg-2', className)} {...props} />
}
