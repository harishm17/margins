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

/**
 * questionMotion for a component that re-renders as the student types: the class is worked out once
 * per change of question and then kept, so an answer being picked does not cut the slide short.
 */
export function useQuestionMotion(current: number): string {
  const [seen, setSeen] = React.useState({ index: current, motion: '' })
  if (seen.index !== current) {
    const next = { index: current, motion: questionMotion(seen.index, current) }
    setSeen(next)
    return next.motion
  }
  return seen.motion
}
