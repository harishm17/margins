'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Spinner } from './spinner'
import { Tooltip } from './tooltip'

const iconButtonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center rounded-control',
    'transition-[background-color,border-color,color,transform] duration-120 ease-enter',
    'active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100',
    '[&>svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        secondary: 'border border-border-strong bg-surface text-fg hover:bg-surface-2',
        primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
      },
      size: {
        sm: 'size-7 max-sm:size-11 [&>svg]:size-4',
        md: 'size-[34px] max-sm:size-11 [&>svg]:size-[18px]',
        lg: 'size-10 max-sm:size-11 [&>svg]:size-5',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  }
)

type IconButtonProps = Omit<React.ComponentProps<'button'>, 'aria-label'> &
  VariantProps<typeof iconButtonVariants> & {
    /** Required: it is the accessible name and the tooltip text. */
    label: string
    icon: React.ReactNode
    shortcut?: string
    loading?: boolean
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
    /** Hide the tooltip, for example when the button sits in a menu that names it. */
    noTooltip?: boolean
  }

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    shortcut,
    loading,
    tooltipSide,
    noTooltip,
    variant,
    size,
    className,
    disabled,
    type = 'button',
    ...props
  },
  ref
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? <Spinner /> : icon}
    </button>
  )
  return noTooltip ? (
    button
  ) : (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  )
})
