import * as React from 'react'
import { Slot, Slottable } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Kbd } from './kbd'
import { DISABLED_FILL, DISABLED_TEXT } from './styles'
import { Spinner } from './spinner'

export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control font-medium select-none',
    'transition-[background-color,border-color,color,transform] duration-120 ease-enter',
    'active:scale-[0.98] disabled:active:scale-100 aria-disabled:active:scale-100',
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary: [
          'bg-accent text-accent-fg hover:bg-accent-hover',
          DISABLED_FILL,
        ].join(' '),
        secondary: [
          'border border-border-strong bg-surface text-fg hover:bg-surface-2',
          DISABLED_FILL,
        ].join(' '),
        ghost: ['text-fg hover:bg-surface-2', DISABLED_TEXT].join(' '),
        danger: ['bg-danger text-danger-fg hover:bg-danger/90', DISABLED_FILL].join(' '),
        // Underlined at rest: a link in a sentence must not rely on colour alone (WCAG 1.4.1). The
        // pseudo-element widens the hit area to 24px, 44px on a phone, without moving the text.
        link: [
          'h-auto min-h-6 rounded-chip p-0 text-accent underline decoration-1 underline-offset-[3px] hover:decoration-2 active:scale-100',
          DISABLED_TEXT,
          'after:absolute after:inset-x-0 after:top-1/2 after:h-6 after:-translate-y-1/2 after:content-[""] max-sm:after:h-11',
        ].join(' '),
      },
      size: {
        sm: 'h-7 gap-1.5 px-2.5 text-small max-sm:h-11 max-sm:text-body',
        md: 'h-[34px] gap-1.5 px-3.5 text-body max-sm:h-11',
        lg: 'h-10 gap-1.5 px-[18px] text-[15px] leading-[22px] max-sm:h-11',
      },
      fullWidth: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', fullWidth: false },
  }
)

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Leading icon, passed as an element: icon={<Plus />}. */
    icon?: React.ReactNode
    /** Keyboard hint shown at the end, e.g. "Enter". */
    kbd?: string
    /**
     * Shows a spinner and disables the button. With a leading icon the spinner takes its place;
     * without one it is centred over the label, so the width never changes.
     */
    loading?: boolean
    /**
     * Why the button is off, as a sentence ("Write a few words first."). Shown as a tooltip and exposed to
     * screen readers through aria-describedby while the button is disabled; ignored when it is enabled.
     * Pass it wherever a button can be disabled, so nobody has to guess why it does nothing.
     */
    disabledReason?: string
  }

export function Button({
  className,
  variant,
  size,
  fullWidth,
  asChild = false,
  icon,
  kbd,
  loading = false,
  disabled,
  disabledReason,
  children,
  type,
  ...props
}: ButtonProps) {
  const reasonId = React.useId()
  const reasonShown = !!disabledReason && !!disabled && !loading
  const Comp = asChild ? Slot : 'button'
  const iconSize = '[&>svg]:size-4'
  const isLink = variant === 'link'

  const button = (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? 'button')}
      disabled={asChild ? undefined : disabled || loading}
      aria-disabled={asChild && (disabled || loading) ? true : undefined}
      aria-busy={loading || undefined}
      title={reasonShown ? disabledReason : props.title}
      className={cn(buttonVariants({ variant, size, fullWidth }), className)}
      {...props}
      aria-describedby={[reasonShown ? reasonId : null, props['aria-describedby']].filter(Boolean).join(' ') || undefined}
    >
      {loading && !icon ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      ) : null}
      {loading && icon ? (
        <Spinner />
      ) : icon ? (
        <span className={cn('inline-flex', iconSize)} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Slottable>
        {asChild ? (
          children
        ) : (
          <span className={cn('truncate', loading && !icon && 'invisible')}>{children}</span>
        )}
      </Slottable>
      {kbd && !isLink ? <Kbd className="ml-0.5 bg-transparent">{kbd}</Kbd> : null}
    </Comp>
  )
  if (!reasonShown) return button
  return (
    <>
      {button}
      <span id={reasonId} className="sr-only">
        {disabledReason}
      </span>
    </>
  )
}
