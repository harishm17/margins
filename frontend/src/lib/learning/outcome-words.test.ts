import { describe, expect, it } from 'vitest'
import { outcomeLabel, outcomeTone } from './outcome-words'

describe('outcome words', () => {
  const table: Array<[Parameters<typeof outcomeLabel>[0], string, string, string]> = [
    [{ correct: true }, 'Correct', 'Right', 'accent'],
    [{ partly: true }, 'Partly', 'Partly', 'warning'],
    [{}, 'Not quite', 'Not quite', 'danger'],
    [{ idk: true }, "Here's what to learn", 'To learn', 'neutral'],
    // An I-don't-know wins over everything else, and is never red.
    [{ idk: true, correct: false, partly: false }, "Here's what to learn", 'To learn', 'neutral'],
  ]
  it.each(table)('%j', (outcome, full, short, tone) => {
    expect(outcomeLabel(outcome)).toBe(full)
    expect(outcomeLabel(outcome, 'short')).toBe(short)
    expect(outcomeTone(outcome)).toBe(tone)
  })
})
