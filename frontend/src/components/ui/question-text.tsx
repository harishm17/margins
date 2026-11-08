'use client'

import * as React from 'react'
import { MathText } from './math-text'

// React.lazy, not next/dynamic: while the renderer's chunk loads, React keeps the server's HTML on screen
// (a Suspense boundary that is still hydrating does), so the question does not collapse to a placeholder
// and grow back. The fallback is only for a question that appears after the page has loaded.
const Markdown = React.lazy(() => import('./markdown').then((m) => ({ default: m.Markdown })))

/** Past this many characters a stem is a paragraph to read, not a headline: it is set at a lighter weight. */
export const LONG_STEM_CHARS = 140
export const stemIsLong = (text: string): boolean => text.trim().length > LONG_STEM_CHARS

/** A stem with a line break holds more than one block: a paragraph break, a table or a code block. */
export const stemHasBlocks = (text: string): boolean => /\n/.test(text.trim())

/**
 * A question stem as the model wrote it. One line is inline text with math. Anything longer (a
 * table of values, a code listing, a second paragraph) goes through the block renderer, so a table
 * stays a table instead of flattening into one run-on line. The block form is a `div`; the inline
 * form is a fragment, so the caller picks the element that holds it (a heading, a paragraph).
 */
export function QuestionText({
  children,
  className,
  compact,
}: {
  children: string
  className?: string
  /** For a review list: 14px, not the heading size of the question page. */
  compact?: boolean
}) {
  if (!stemHasBlocks(children)) return <MathText className={className}>{children}</MathText>
  return (
    <React.Suspense fallback={<div className={`whitespace-pre-wrap ${compact ? 'text-body' : 'text-heading'} ${className ?? ''}`}>{children}</div>}>
      <Markdown variant={compact ? 'stem-compact' : 'stem'} className={stemIsLong(children) && !compact ? `md-stem-long ${className ?? ''}` : className}>
        {children}
      </Markdown>
    </React.Suspense>
  )
}
