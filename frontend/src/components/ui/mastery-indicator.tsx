'use client'

import {
  masteryDescription,
  masteryLabel,
  masteryLevel,
  masteryPercent,
  masteryTone,
} from '@/lib/mastery'
import { cn } from '@/lib/utils'
import { ProgressRing } from './progress-ring'
import { Tooltip } from './tooltip'

type MasteryIndicatorProps = {
  /** 0..1 from ReviewSchedule.mastery, or null when there is no signal yet. */
  mastery: number | null | undefined
  /** "label": ring and text. "ring": ring only, with a tooltip, for dense lists. */
  variant?: 'label' | 'ring'
  showPercent?: boolean
  /** Words for "no mastery yet" when something has been done already ("In progress"), instead of "Not started". */
  emptyLabel?: string
  className?: string
}

export function MasteryIndicator({ mastery, variant = 'label', showPercent, emptyLabel, className }: MasteryIndicatorProps) {
  const level = masteryLevel(mastery)
  const ring = (
    <ProgressRing
      size={16}
      value={level === 'none' ? null : mastery}
      tone={masteryTone(level) === 'warning' ? 'warning' : 'accent'}
      aria-label={variant === 'ring' ? masteryDescription(mastery) : undefined}
    />
  )

  if (variant === 'ring') {
    return (
      <Tooltip content={masteryDescription(mastery)} side="right">
        <span className={cn('inline-flex', className)}>{ring}</span>
      </Tooltip>
    )
  }

  const percent = masteryPercent(mastery)
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-caption text-fg-2', className)}>
      {ring}
      <span>
        {level === 'none' && emptyLabel ? emptyLabel : masteryLabel(mastery)}
        {showPercent && percent !== null ? <span className="tabular">{` ${percent}%`}</span> : null}
      </span>
    </span>
  )
}
