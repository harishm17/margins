'use client'

import Link from 'next/link'
import { X } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { MathText } from '@/components/ui/math-text'
import { useTopic } from './topic-provider'

/**
 * The small header of an attempt on a phone (a warm-up question, a recall answer, a practice problem, a quiz): who this is
 * (the topic) and the way out, the pattern of the mock exam's and the review's focus bar. While it shows, the topic's own
 * header and five-step path are hidden (`group-data-[attempt]/topic:max-sm:hidden`), so the question and its next action
 * are the first things on the screen. It is not drawn on a wide screen, where the path costs nothing, nor outside an
 * attempt (the lobbies and results keep the whole path).
 */
export function AttemptBar({ courseId, name }: { courseId: string; name: string }) {
  const { attempt } = useTopic()
  if (!attempt) return null
  return (
    <div data-testid="attempt-bar" className="-mt-1 mb-1 flex min-h-11 items-center gap-2 sm:hidden">
      {attempt.onExit ? (
        <Button variant="ghost" size="sm" icon={<X />} className="-ml-2" onClick={attempt.onExit}>
          Exit
        </Button>
      ) : (
        <Button asChild variant="ghost" size="sm" icon={<X />} className="-ml-2">
          <Link href={attempt.exitHref ?? `/courses/${courseId}/topics`}>Exit</Link>
        </Button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-body-strong text-fg">
        <MathText>{name}</MathText>
      </h1>
    </div>
  )
}
