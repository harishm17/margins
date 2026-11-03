/**
 * Finds the first step the student's working got wrong, without the model (spec §6.1). The authored
 * answers are known, so the numbers in the working can be compared with them in order. This turns
 * "where did it go wrong" into a fact the tutor is handed.
 */

import { numberCandidates, withinTolerance } from '@/features/topic/practice-check'

export type KeyedStep = { answer: string; tolerance?: number | null }

// A number, optionally negative, with thousands separators or a decimal part, optionally the top of a
// fraction ("3/28") or followed by a percent sign. A "-" glued to the digits after a word or a number
// is a minus sign ("5-3"), not a negative value.
const NUMBER = /(?<![\w.)])([-−])?(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:[eE]([-+]?\d+))?(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*(%)?/g

/** Every value the working states, in order. A fraction gives its parts and its quotient, a percent both readings. */
export function numbersIn(working: string): number[] {
  const found: number[] = []
  for (const match of working.matchAll(NUMBER)) {
    const sign = match[1] ? -1 : 1
    let value = Number(match[2].replace(/,/g, ''))
    if (match[3] !== undefined) value *= 10 ** Number(match[3])
    if (!Number.isFinite(value)) continue
    found.push(sign * value)
    if (match[4] !== undefined) {
      const bottom = Number(match[4])
      found.push(bottom)
      if (bottom !== 0) found.push((sign * value) / bottom)
    }
    if (match[5]) found.push((sign * value) / 100)
  }
  return found
}

const matches = (given: number, target: number, tolerance: number | null | undefined) =>
  typeof tolerance === 'number' && Number.isFinite(tolerance) && tolerance >= 0
    ? Math.abs(given - target) <= tolerance + 1e-9
    : withinTolerance(given, target)

/**
 * The 0-based index of the first step whose authored value is missing from the working while a later
 * step's value, or a number that is no step's value, is there. Null when the working has no numbers,
 * when every value is there, when the only gap is the step after the last one done, or when the
 * answers are not numbers (the field is then left out). Numbers that only copy the problem's givens
 * (`givens` is its statement and step questions) are not counted.
 */
export function firstWrongStep(working: string, steps: KeyedStep[], givens = ''): number | null {
  const targets = steps.map((step) => numberCandidates(step.answer, true))
  const isAnswer = (given: number) => steps.some((step, other) => targets[other]?.some((target) => matches(given, target, step.tolerance)))
  // Numbers copied from the problem are its givens, not work, unless they are also an answer.
  const givenNumbers = numbersIn(givens)
  const stated = numbersIn(working).filter((given) => isAnswer(given) || !givenNumbers.includes(given))
  if (stated.length === 0) return null
  const present = (index: number) => {
    const wanted = targets[index]
    return !!wanted && wanted.some((target) => stated.some((given) => matches(given, target, steps[index].tolerance)))
  }
  for (let index = 0; index < steps.length; index++) {
    if (!targets[index] || present(index)) continue
    const laterThere = steps.some((_step, later) => later > index && present(later))
    const stray = stated.some((given) => !isAnswer(given))
    return laterThere || stray ? index : null
  }
  return null
}
