'use client'

import * as React from 'react'
import * as RadioGroup from '@radix-ui/react-radio-group'
import { cn } from '@/lib/utils'

export type SegmentedOption<T extends string> = {
  value: T
  label: React.ReactNode
  disabled?: boolean
}

type SegmentedControlProps<T extends string> = {
  options: SegmentedOption<T>[]
  value: T
  onValueChange: (value: T) => void
  /** Name the group for screen readers. */
  'aria-label'?: string
  'aria-labelledby'?: string
  fullWidth?: boolean
  disabled?: boolean
  className?: string
}

/** A radio group drawn as a track with a raised selected item. Arrow keys move and select. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  fullWidth,
  disabled,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      disabled={disabled}
      orientation="horizontal"
      loop
      className={cn(
        'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-control bg-surface-2 p-0.5',
        fullWidth && 'flex w-full',
        className
      )}
      {...aria}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            'h-[30px] max-sm:h-11 whitespace-nowrap rounded-chip border border-transparent px-3 text-small font-medium text-fg-2',
            'transition-[background-color,color,border-color] duration-120',
            'hover:text-fg disabled:opacity-50',
            'data-[state=checked]:border-accent data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-tiny',
            fullWidth && 'flex-1'
          )}
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
