/**
 * Chunks of one file overlap by design (the chunker repeats the tail of a chunk at the start of the next, up
 * to 400 characters), so a reader that printed them one after the other would say every last sentence twice
 * (spec §5.2). `stripOverlap(prev, next)` finds the longest suffix of `prev`, looking at no more than its last
 * 600 characters, that is also a prefix of `next` once whitespace is normalised, and returns `next` without it.
 * The overlap stays in `prev`, so a quote or a margin note anchored near the end of a passage keeps its place.
 */

export const MAX_OVERLAP_CHARS = 600
/** Below this a shared run of characters is a coincidence, not a repeated tail. */
const MIN_OVERLAP_CHARS = 20

/** `text` with every whitespace run as one space and the leading whitespace gone, and where each kept character came from. */
function normalise(text: string): { text: string; origin: number[] } {
  let out = ''
  const origin: number[] = []
  let inSpace = true
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (!inSpace) {
        out += ' '
        origin.push(i)
        inSpace = true
      }
    } else {
      out += text[i]
      origin.push(i)
      inSpace = false
    }
  }
  return { text: out, origin }
}

export function stripOverlap(prev: string, next: string): string {
  const before = normalise(prev).text.trimEnd()
  const after = normalise(next)
  const window = before.slice(-MAX_OVERLAP_CHARS)
  const longest = Math.min(window.length, after.text.length)
  for (let length = longest; length >= MIN_OVERLAP_CHARS; length--) {
    if (after.text.startsWith(window.slice(window.length - length))) {
      return next.slice(after.origin[length - 1] + 1).trimStart()
    }
  }
  return next
}
