import * as React from 'react'
import { cn } from '@/lib/utils'

export type InputProps = Omit<React.ComponentProps<'input'>, 'size'> & {
  /** Leading icon element (16px): icon={<MagnifyingGlass />}. */
  icon?: React.ReactNode
  /** Trailing slot: a unit, a kbd hint, a clear or show/hide button. */
  trailing?: React.ReactNode
  invalid?: boolean
  /** Classes for the box (border, width); `className` goes to the input element. */
  containerClassName?: string
}

/**
 * 34px, surface, 1px strong border, radius 8. The box is a div so icons and trailing content
 * sit inside the border; focus shows on the box.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, containerClassName, icon, trailing, invalid, ...props },
  ref
) {
  return (
    <div
      className={cn(
        'flex h-[34px] max-sm:h-11 w-full items-center gap-2 rounded-control border border-control bg-surface px-3',
        'transition-[border-color,box-shadow] duration-120',
        'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25',
        invalid && 'border-danger focus-within:border-danger focus-within:ring-danger/25',
        'has-[:disabled]:bg-surface-2 has-[:disabled]:text-fg-3',
        containerClassName
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex text-fg-3 [&>svg]:size-4">
          {icon}
        </span>
      ) : null}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent text-body max-sm:text-[16px] text-fg outline-none placeholder:text-fg-3 disabled:cursor-not-allowed',
          className
        )}
        {...props}
      />
      {trailing ? <span className="inline-flex shrink-0 items-center text-small text-fg-2">{trailing}</span> : null}
    </div>
  )
})
