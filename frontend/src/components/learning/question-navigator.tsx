'use client'

import * as React from 'react'
import { Check, Flag } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'

const NONE: ReadonlySet<number> = new Set()

type QuestionNavigatorProps = {
  total: number
  /** The question on screen (0-based). */
  current: number
  /** Question numbers (0-based) with an answer. */
  answered: ReadonlySet<number>
  /** Question numbers (0-based) the student marked to come back to. A quiz has none. */
  flagged?: ReadonlySet<number>
  onSelect: (index: number) => void
  /**
   * `grid` is five to a row with a count under it (the exam's side panel and the phone sheet); `row` is one line of numbers
   * that wraps on a wide screen and scrolls sideways on a phone, with the current one kept in view (the quiz).
   */
  layout?: 'grid' | 'row'
  className?: string
}

/**
 * The question numbers of a quiz or a mock exam, drawn one way for both. Three states, none of them a faint fill alone:
 * answered has a check, the current question has a heavy accent outline and a bar under its number, and a flagged one carries a
 * flag. Every number is a 44px target on a phone. Each button says its state in words.
 */
export function QuestionNavigator({ total, current, answered, flagged = NONE, onSelect, layout = 'grid', className }: QuestionNavigatorProps) {
  const rowRef = React.useRef<HTMLElement>(null)
  // The current number stays in view in a row that scrolls (the page itself is left where it is).
  React.useEffect(() => {
    const row = rowRef.current
    const tile = row?.querySelector<HTMLElement>('[aria-current="step"]')
    if (row && tile && row.scrollWidth > row.clientWidth) row.scrollLeft = tile.offsetLeft - (row.clientWidth - tile.offsetWidth) / 2
  }, [current])

  const chips = Array.from({ length: total }, (_, index) => {
    const isCurrent = index === current
    const isAnswered = answered.has(index)
    const isFlagged = flagged.has(index)
    return (
      <button
        key={index}
        type="button"
        onClick={() => onSelect(index)}
        aria-current={isCurrent ? 'step' : undefined}
        aria-label={`Question ${index + 1}${isAnswered ? ', answered' : ', not answered'}${isFlagged ? ', flagged' : ''}`}
        className={cn(
          'relative inline-flex shrink-0 items-center justify-center gap-0.5 rounded-chip border text-small tabular transition-colors duration-120',
          layout === 'grid' ? 'h-10 w-full max-sm:h-11' : 'size-8 max-sm:size-11',
          isCurrent
            ? 'border-2 border-accent bg-accent-soft font-medium text-accent-soft-fg after:absolute after:inset-x-1.5 after:bottom-0.5 after:h-0.5 after:rounded-full after:bg-accent'
            : isAnswered
              ? 'border-border-strong bg-surface-3 text-fg'
              : 'border-border-strong bg-surface text-fg-2 hover:bg-surface-2'
        )}
      >
        {isAnswered ? <Check weight="bold" aria-hidden="true" className="size-3 shrink-0" /> : null}
        {index + 1}
        {isFlagged ? <Flag weight="fill" aria-hidden="true" className="absolute -right-1 -top-1 size-3.5 rounded-full bg-surface text-warning" /> : null}
      </button>
    )
  })

  if (layout === 'row') {
    return (
      <nav ref={rowRef} aria-label="Questions" className={cn('relative flex flex-wrap items-center gap-1.5 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:pb-1', className)}>
        {chips}
      </nav>
    )
  }
  return (
    <div className={className}>
      <ul className="grid grid-cols-5 gap-1.5">
        {chips.map((chip, index) => (
          <li key={index}>{chip}</li>
        ))}
      </ul>
      <p className="mt-3 text-small text-fg-2 tabular">
        {answered.size} answered{flagged.size > 0 ? `, ${flagged.size} flagged` : ''}
      </p>
    </div>
  )
}
