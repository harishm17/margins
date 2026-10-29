import * as React from 'react'
import { cn } from '@/lib/utils'

const STROKE = { 16: 2, 28: 3, 44: 4, 96: 7 } as const
export type RingSize = keyof typeof STROKE

type ProgressRingProps = {
  /** 0 to 1. null or undefined draws the empty state: a dashed track and no arc. */
  value?: number | null
  size?: RingSize
  tone?: 'accent' | 'warning'
  /** Centre label (tabular). Shown from size 28 up. */
  label?: React.ReactNode
  /** Names the ring for screen readers. Without it the ring is decorative. */
  'aria-label'?: string
  className?: string
}

const LABEL_CLASS: Record<RingSize, string> = {
  16: 'hidden',
  28: 'text-[9px] font-medium',
  44: 'text-caption',
  96: 'text-title',
}

/** The arc of a "learning" ring as ten segments around the circle, each followed by a gap of a quarter of its width. */
function dashes(circumference: number, fraction: number): { start: number; length: number }[] {
  const segment = circumference / 10
  const drawn = segment * 0.75
  const filled = circumference * fraction
  const out: { start: number; length: number }[] = []
  for (let start = 0; start < filled - 0.01; start += segment) {
    out.push({ start, length: Math.min(drawn, filled - start) })
  }
  return out
}

export function ProgressRing({ value, size = 28, tone = 'accent', label, className, ...aria }: ProgressRingProps) {
  const stroke = STROKE[size]
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const empty = value === null || value === undefined
  const clamped = empty ? 0 : Math.min(1, Math.max(0, value))
  const labelled = !!aria['aria-label']

  return (
    <span
      role={labelled ? 'img' : undefined}
      aria-label={aria['aria-label']}
      aria-hidden={labelled ? undefined : true}
      className={cn('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className={empty ? 'stroke-border-strong' : 'stroke-surface-3'}
          strokeDasharray={empty ? `${Math.max(2, stroke)} ${Math.max(2, stroke) + 1}` : undefined}
        />
        {empty || clamped === 0 ? null : tone === 'warning' ? (
          // "Learning" is not carried by amber alone: the arc is drawn as separate dashes.
          dashes(circumference, clamped).map((dash) => (
            <circle
              key={dash.start}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              strokeDasharray={`${dash.length} ${circumference}`}
              strokeDashoffset={-dash.start}
              className="stroke-warning"
            />
          ))
        ) : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * clamped} ${circumference}`}
            className={cn('transition-[stroke-dasharray] duration-240 ease-enter', tone === 'accent' ? 'stroke-accent' : 'stroke-warning')}
          />
        )}
      </svg>
      {label !== undefined && label !== null ? (
        <span className={cn('absolute inset-0 grid place-items-center tabular text-fg', LABEL_CLASS[size])}>{label}</span>
      ) : null}
    </span>
  )
}
