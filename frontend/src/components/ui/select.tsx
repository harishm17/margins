'use client'

import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { CaretUpDown, Check } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'
import { floatingSurface, menuItem, popperMotion } from './styles'

export type SelectOption = {
  value: string
  label: React.ReactNode
  /** A second, quieter line or suffix, e.g. a course name. */
  hint?: React.ReactNode
  disabled?: boolean
}

type SelectProps = {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  id?: string
  name?: string
  disabled?: boolean
  invalid?: boolean
  className?: string
  contentClassName?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}

/**
 * A Radix select styled like Input. The list box gets the trigger's name too (`aria-labelledby`, which
 * `Field` passes, or `aria-label`), so the open list is named. A select outside a Field needs one of them.
 */
export function Select({
  options,
  placeholder = 'Select',
  invalid,
  className,
  contentClassName,
  id,
  disabled,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
  ...root
}: SelectProps) {
  return (
    <SelectPrimitive.Root disabled={disabled} {...root}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex h-[34px] max-sm:h-11 w-full items-center justify-between gap-2 rounded-control border border-control bg-surface px-3 text-left text-body text-fg outline-none',
          'transition-[border-color,box-shadow] duration-120',
          'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25',
          'aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25',
          'data-[placeholder]:text-fg-3 disabled:bg-surface-2 disabled:text-fg-3',
          className
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon asChild>
          <CaretUpDown className="size-4 shrink-0 text-fg-3" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            floatingSurface,
            popperMotion,
            'max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden p-1',
            contentClassName
          )}
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(menuItem, 'pr-8')}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                {option.hint ? <span className="ml-auto text-caption font-normal text-fg-3">{option.hint}</span> : null}
                <SelectPrimitive.ItemIndicator className="absolute right-2.5 inline-flex">
                  <Check weight="bold" className="size-4 text-accent" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
