import * as React from 'react'
import { CheckCircle, Info, Warning, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const alertVariants = cva('flex w-full items-start gap-3 rounded-control px-3.5 py-3 max-sm:flex-wrap', {
  variants: {
    tone: {
      neutral: 'bg-surface-2 text-fg-2',
      accent: 'bg-accent-soft text-accent-soft-fg',
      warning: 'bg-warning-soft text-warning-soft-fg',
      danger: 'bg-danger-soft text-danger-soft-fg',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

const ICONS = {
  neutral: Info,
  accent: CheckCircle,
  warning: Warning,
  danger: WarningCircle,
} as const

type InlineAlertProps = Omit<React.ComponentProps<'div'>, 'title'> &
  VariantProps<typeof alertVariants> & {
    title?: React.ReactNode
    /** An icon element to use instead of the tone's default. */
    icon?: React.ReactNode
    /** A button or link on the right; below the sm breakpoint it sits under the text and fills the width. */
    action?: React.ReactNode
  }

export function InlineAlert({ className, tone = 'neutral', title, icon, action, children, ...props }: InlineAlertProps) {
  const Icon = ICONS[tone ?? 'neutral']
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0 [&>svg]:size-4">
        {icon ?? <Icon />}
      </span>
      {/* Below sm the action wraps onto its own full-width row, so the message keeps the width of the alert
          (a side-by-side action left it a narrow column of a few words) and reads at the body size. */}
      <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-1.75rem)]">
        {title ? <p className={cn('text-body-strong', tone === 'neutral' ? 'text-fg' : 'text-current')}>{title}</p> : null}
        {children ? <div className="text-small max-sm:text-body">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center max-sm:w-full max-sm:self-stretch max-sm:[&>*]:w-full">{action}</div> : null}
    </div>
  )
}
