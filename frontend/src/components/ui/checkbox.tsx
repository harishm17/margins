'use client'

import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'

type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  /** With a label the whole row is clickable. */
  label?: React.ReactNode
  description?: React.ReactNode
  /** Extra content at the end of the row, e.g. a mastery ring. */
  trailing?: React.ReactNode
}

export function Checkbox({ className, label, description, trailing, id, ...props }: CheckboxProps) {
  const generated = React.useId()
  const inputId = id ?? generated

  const box = (
    <CheckboxPrimitive.Root
      id={inputId}
      className={cn(
        'relative mt-px grid size-4 shrink-0 place-items-center rounded-[5px] border border-control bg-surface text-accent-fg',
        // A 24px hit area around the 16px box (WCAG 2.5.8) that does not move anything.
        'after:absolute after:-inset-1 after:content-[""] max-sm:after:-inset-3',
        'transition-colors duration-120',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        'disabled:border-border-strong disabled:bg-surface-3 disabled:text-fg-3',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        {props.checked === 'indeterminate' ? (
          <Minus weight="bold" className="size-3" />
        ) : (
          <Check weight="bold" className="size-3" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )

  if (!label) return box
  return (
    <div className="flex items-start gap-2.5">
      {box}
      <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer text-body leading-[18px] text-fg">
        {label}
        {description ? <span className="mt-0.5 block text-small text-fg-2">{description}</span> : null}
      </label>
      {trailing}
    </div>
  )
}
