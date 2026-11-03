/**
 * What the student actually heard of the coach's reply (spec 19.4): the sentences that played to
 * their end, plus the one that was cut off. Sent with the next turn when the student interrupts,
 * so the model knows what was said and what never got said.
 */

export type HeardTracker = {
  /** A reply sentence started playing. `speech` is what was said (it can differ from `display`, see speakable()). */
  start: (display: string, speech: string) => void
  /** The voice reached a word: `charIndex` counts in `speech`. */
  boundary: (charIndex: number) => void
  /** The sentence played to its end. */
  finish: () => void
  /** The browser could not say it: it was not heard. */
  abandon: () => void
  /** The reply so far: finished sentences, then the cut-off one (only as far as the voice got when it is known). */
  text: () => string
  /** Anything has played. */
  readonly any: boolean
  reset: () => void
}

/** The end of the word that starts at or before `index` in `text`. */
export function wordEnd(text: string, index: number): number {
  let i = Math.max(0, Math.min(index, text.length))
  while (i < text.length && !/\s/.test(text[i])) i += 1
  return i
}

export function createHeardTracker(): HeardTracker {
  const finished: string[] = []
  let current: { display: string; speech: string; reached: number | null } | null = null

  const cutOff = (): string => {
    if (!current) return ''
    // With word boundaries and the same text on screen and in speech, cut where the voice stopped.
    if (current.reached !== null && current.display === current.speech) {
      return current.display.slice(0, wordEnd(current.display, current.reached)).trim()
    }
    return current.display
  }

  return {
    start(display, speech) {
      current = { display: display.trim(), speech, reached: null }
    },
    boundary(charIndex) {
      if (current) current.reached = charIndex
    },
    finish() {
      if (current && current.display) finished.push(current.display)
      current = null
    },
    abandon() {
      current = null
    },
    text() {
      return [...finished, cutOff()].filter(Boolean).join(' ').trim()
    },
    get any() {
      return finished.length > 0 || current !== null
    },
    reset() {
      finished.length = 0
      current = null
    },
  }
}
