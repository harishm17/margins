import * as React from 'react'
import { ArrowSquareOut } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { MathText } from '@/components/ui/math-text'
import type { BoardItem } from './session-state'

const LABEL: Record<BoardItem['kind'], string> = {
  question: 'Question',
  concept: 'Explain this',
  prediction: 'Predict first',
  claim: 'Your pages say',
}

/**
 * The board (spec §5.8): the question, idea or claim the coach is on, as text, with maths drawn by the same component the
 * rest of the app uses and a link to the page it comes from. The coach never has to read a formula aloud, and the student
 * can look back at what was asked: nothing is only audio.
 */
export function Board({ board }: { board: BoardItem | null }) {
  if (!board) return null
  const page = board.source
  return (
    <section aria-label="On the board" data-testid="voice-board" data-kind={board.kind} className="rounded-card border border-border bg-surface p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption font-medium uppercase tracking-wide text-fg-3">{LABEL[board.kind]}</p>
        {page ? (
          <a
            href={page.href}
            target="_blank"
            rel="noreferrer"
            data-testid="voice-board-source"
            aria-label={`Open ${page.label} in your files (opens in a new tab)`}
            className="inline-flex min-h-6 items-center gap-1 rounded-chip text-caption font-medium text-accent hover:text-accent-hover max-sm:min-h-11"
          >
            {page.label}
            <ArrowSquareOut aria-hidden className="size-3.5" />
          </a>
        ) : null}
      </div>
      <div className="mt-2" data-testid={board.kind === 'question' ? 'voice-question' : undefined}>
        {board.kind === 'claim' ? (
          <p className="text-body text-fg">
            <MathText>{board.text}</MathText>
          </p>
        ) : (
          <h2 className="text-heading text-fg">
            <MathText>{board.text}</MathText>
          </h2>
        )}
        {board.options && board.options.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {board.options.map((option) => (
              <li key={option.id} className="flex items-baseline gap-2 text-body text-fg-2">
                <Badge tone="neutral" className="shrink-0 justify-center">
                  {option.id}
                </Badge>
                <span>
                  <MathText>{option.text}</MathText>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {board.question ? (
        <div className="mt-3 border-t border-border pt-3" data-testid="voice-board-check">
          <p className="text-caption font-medium uppercase tracking-wide text-fg-3">Check</p>
          <p className="mt-1 text-body text-fg">
            <MathText>{board.question}</MathText>
          </p>
        </div>
      ) : null}
    </section>
  )
}
