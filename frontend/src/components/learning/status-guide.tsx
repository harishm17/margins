import * as React from 'react'
import { CaretDown } from '@phosphor-icons/react/dist/ssr'
import { LEARNING_BELOW, MASTERY_LABELS, STRONG_FROM } from '@/lib/mastery'
import { LABEL_TEXT } from '@/lib/map/copy'
import { cn } from '@/lib/utils'

/** The four things a student sees side by side that mean different things. */
export type StatusPart = 'topic' | 'idea' | 'steps' | 'quiz'

const ALL_PARTS: StatusPart[] = ['topic', 'idea', 'steps', 'quiz']

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

/**
 * What the words and numbers on a course's screens mean, in one place: a topic's status, an idea's status (the Map's states),
 * a finished step and a quiz score. They measure different things and show up together (the overview, the Map, the Topics list,
 * a topic's header), so each of those places uses this one disclosure with the same words, taken from lib/mastery.ts and
 * lib/map/copy.ts. It is closed until asked for: a plain "What these mean" line, then the explanations.
 *
 *   <StatusGuide />                               all four
 *   <StatusGuide parts={['topic', 'steps']} />    only the ones that are on that screen
 *
 * `id` makes the disclosure's own id unique when two are on a page; `className` places it.
 */
export function StatusGuide({ parts = ALL_PARTS, id = 'status-guide', className }: { parts?: StatusPart[]; id?: string; className?: string }) {
  const has = (part: StatusPart) => parts.includes(part)
  return (
    <details className={cn('group text-small text-fg-2', className)} data-testid="status-guide">
      <summary
        id={id}
        className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-chip text-fg-2 hover:text-fg max-sm:min-h-11 [&::-webkit-details-marker]:hidden"
      >
        What these mean
        <CaretDown aria-hidden="true" className="size-3.5 transition-transform duration-180 group-open:rotate-180" />
      </summary>
      <dl className="mt-2 flex max-w-[68ch] flex-col gap-3">
        {has('topic') ? (
          <div>
            <dt className="font-medium text-fg">Topic status</dt>
            <dd className="mt-0.5">
              How well you know a whole topic, from your recent answers and how long ago they were: {MASTERY_LABELS.none} (nothing answered yet),{' '}
              {MASTERY_LABELS.learning} (under {percent(LEARNING_BELOW)}), {MASTERY_LABELS.getting} ({percent(LEARNING_BELOW)} to {percent(STRONG_FROM - 0.01)}) and{' '}
              {MASTERY_LABELS.strong} ({percent(STRONG_FROM)} or more). It is the average of the topic&apos;s ideas.
            </dd>
          </div>
        ) : null}
        {has('idea') ? (
          <div>
            <dt className="font-medium text-fg">Idea status</dt>
            <dd className="mt-0.5">
              The same scale for one idea inside a topic, with a few more words: {LABEL_TEXT.shaky} (missed or helped lately), {LABEL_TEXT.getting_there},{' '}
              {LABEL_TEXT.solid}, {LABEL_TEXT.fading} (was solid, not seen for a while) and {LABEL_TEXT.inferred} (credited through a related idea, not yet tested on its own).
            </dd>
          </div>
        ) : null}
        {has('steps') ? (
          <div>
            <dt className="font-medium text-fg">A finished step</dt>
            <dd className="mt-0.5">
              A tick on Warm-up, Read, Recall, Practice or Quiz means you did that step. It shows where you have been, not how well you know the topic.
            </dd>
          </div>
        ) : null}
        {has('quiz') ? (
          <div>
            <dt className="font-medium text-fg">A quiz score</dt>
            <dd className="mt-0.5">
              How you did on one quiz. It counts toward the topic&apos;s status along with your later reviews, but it is not the status itself.
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  )
}
