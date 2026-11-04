'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export type TextareaProps = React.ComponentProps<'textarea'> & {
  invalid?: boolean
  /** Grow with the content, up to `maxRows`. On by default. */
  autoGrow?: boolean
  maxRows?: number
}

const LINE = 22

/** Min 3 rows, grows as you type. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, autoGrow = true, maxRows = 12, rows = 3, onInput, value, ...props },
  forwardedRef
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)

  const resize = React.useCallback(() => {
    const el = innerRef.current
    if (!el || !autoGrow) return
    el.style.height = 'auto'
    const max = maxRows * LINE + 16
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`
    el.style.overflowY = el.scrollHeight + 2 > max ? 'auto' : 'hidden'
  }, [autoGrow, maxRows])

  React.useLayoutEffect(resize, [resize, value])

  return (
    <textarea
      ref={(node) => {
        innerRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      rows={rows}
      value={value}
      aria-invalid={invalid || undefined}
      onInput={(event) => {
        resize()
        onInput?.(event)
      }}
      className={cn(
        'block w-full resize-none rounded-control border border-control bg-surface px-3 py-2 text-body max-sm:text-[16px] text-fg outline-none',
        'transition-[border-color,box-shadow] duration-120 placeholder:text-fg-3',
        'focus:border-accent focus:ring-2 focus:ring-accent/25',
        'aria-invalid:border-danger aria-invalid:focus:ring-danger/25',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-3',
        !autoGrow && 'resize-y',
        className
      )}
      {...props}
    />
  )
})
