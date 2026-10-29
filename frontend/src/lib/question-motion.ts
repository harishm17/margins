import * as React from 'react'

/**
 * The class for a question that has just changed, from where the student was to where they are:
 * one step forward slides in from the right, one step back from the left, a jump (the navigator)
 * fades because it has no direction, and the same question (first paint, a resume) does not move.
 * The classes are the tokens in app/globals.css (240 ms slide, 180 ms fade).
 */
export function questionMotion(previous: number, current: number): string {
  const step = current - previous
  if (step === 0) return ''
  if (step === 1) return 'animate-slide-in'
  if (step === -1) return 'animate-slide-in-back'
  return 'animate-fade-in'
}

export type SeenQuestion = { index: number; live: boolean; motion: string }

/**
 * The next state of useQuestionMotion. A question that arrives while the page is still hydrating
 * (`seen.live` false) is where the student already was, such as an exam resumed from sessionStorage,
 * which the first render does not know yet: it shows without motion.
 */
export function nextSeenQuestion(seen: SeenQuestion, current: number, live: boolean): SeenQuestion {
  if (seen.index === current && seen.live === live) return seen
  const moved = seen.index !== current
  return { index: current, live, motion: moved && seen.live ? questionMotion(seen.index, current) : moved ? '' : seen.motion }
}

const noSubscribe = () => () => {}

/**
 * questionMotion for a component that re-renders as the student types: the class is worked out once
 * per change of question and then kept, so an answer being picked does not cut the slide short.
 * Nothing moves until the page has hydrated: server and first client render share one snapshot, and a
 * value read from the browser after that (a resumed exam) is not a step.
 */
export function useQuestionMotion(current: number): string {
  const live = React.useSyncExternalStore(noSubscribe, () => true, () => false)
  const [seen, setSeen] = React.useState<SeenQuestion>({ index: current, live, motion: '' })
  const next = nextSeenQuestion(seen, current, live)
  if (next !== seen) setSeen(next)
  return next.motion
}
