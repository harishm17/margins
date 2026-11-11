import type { VoiceOption } from '@/lib/voice/turn-client'

/** The question a coach turn put on the board, kept with the turn so the screen can tell when the turn reads it out. */
export type AskedQuestion = { text: string; options?: Pick<VoiceOption, 'text'>[] }

/** A coach turn split around the stretch where it reads out the question on the board. */
export type Reading = { before: string; reading: string; after: string }

/** How much of the question's start has to match, in letters and digits. */
const START_ANCHOR = 40
/** How much of the last thing read out (the last option, or the question's end) has to match. */
const END_ANCHOR = 30

/** The text's letters and digits, lower case, with the place in the text each one came from. */
function lettersOf(text: string): { flat: string; at: number[] } {
  let flat = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (!/[\p{L}\p{N}]/u.test(text[i])) continue
    const lower = text[i].toLowerCase()
    flat += lower
    for (let k = 0; k < lower.length; k += 1) at.push(i)
  }
  return { flat, at }
}

/**
 * Finds where a coach turn reads out the question on the board (the question, then its options), so the screen can show
 * the board once instead of twice. Matching is on letters and digits only, so punctuation, "A," or "Option A:" and line
 * breaks do not matter. When the reading cannot be found whole (a formula said in words, a reworded question) the turn is
 * shown as it is: nothing the coach said is hidden on a guess. While the turn is still arriving, a reading that has begun
 * counts from its start to the end of what has arrived.
 */
export function splitReading(text: string, question: AskedQuestion | undefined, streaming: boolean): Reading | null {
  if (!question) return null
  const stem = lettersOf(question.text).flat
  if (stem.length < 20) return null
  const said = lettersOf(text)
  const start = said.flat.indexOf(stem.slice(0, START_ANCHOR))
  if (start < 0) return null

  const options = question.options ?? []
  const last = options.length > 0 ? lettersOf(options[options.length - 1].text).flat : stem
  const tail = last.slice(-END_ANCHOR)
  const found = tail ? said.flat.indexOf(tail, start) : -1

  const from = said.at[start]
  let to: number
  if (found >= 0) {
    to = said.at[found + tail.length - 1] + 1
    // The sentence's own closing marks go with it.
    while (to < text.length && /[.?!)"'’”:;,]/.test(text[to])) to += 1
  } else if (streaming) {
    to = text.length
  } else {
    return null
  }
  return { before: text.slice(0, from).trimEnd(), reading: text.slice(from, to).trim(), after: text.slice(to).trimStart() }
}
