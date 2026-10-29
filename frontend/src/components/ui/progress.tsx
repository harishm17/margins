import { cn } from '@/lib/utils'

type ProgressProps = {
  /** 0 to 100. Ignored when indeterminate. */
  value?: number
  indeterminate?: boolean
  tone?: 'accent' | 'warning'
  'aria-label': string
  className?: string
}

/** A 4px bar. Indeterminate shows a moving 30% segment. */
export function Progress({ value = 0, indeterminate, tone = 'accent', className, ...aria }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value))
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-surface-3', className)}
      {...aria}
    >
      <div
        className={cn(
          'h-full rounded-full',
          tone === 'accent' ? 'bg-accent' : 'bg-learning',
          indeterminate ? 'w-[30%] animate-indeterminate' : 'transition-[width] duration-240 ease-enter'
        )}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  )
}
