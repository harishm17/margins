/**
 * Backchannels: the small sounds a listener makes while someone else talks ("yeah", "mm-hm",
 * "okay"). While the coach speaks they must not count as an interruption (spec 19.4).
 *
 * An interruption needs a recognised word that is not a backchannel and not an echo of the coach
 * (isEcho in silence.ts keeps that half).
 */

/** Said alone or in a short run. Hyphens and punctuation are ignored: "mm-hm" is "mm hm". */
const PHRASES: string[][] = [
  ['yeah'], ['yes'], ['yep'], ['yup'], ['ya'], ['mm', 'hm'], ['mm', 'hmm'], ['mhm'], ['mmhm'], ['mm'], ['hmm'], ['hm'],
  ['uh', 'huh'], ['uhuh'], ['uh', 'hm'], ['okay'], ['ok'], ['o', 'k'], ['right'], ['sure'], ['got', 'it'], ['i', 'see'],
  ['alright'], ['all', 'right'], ['i', 'got', 'it'],
]

/** A run longer than this is a sentence, not a nod. */
const MAX_WORDS = 6

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean)

// Longest phrase first, so "got it" is read as one backchannel and not "got" + "it".
const SORTED = [...PHRASES].sort((a, b) => b.length - a.length)

/** True when every word of the text belongs to a backchannel phrase. */
export function isBackchannel(text: string): boolean {
  const words = tokens(text)
  if (words.length === 0 || words.length > MAX_WORDS) return false
  let i = 0
  while (i < words.length) {
    const phrase = SORTED.find((candidate) => candidate.every((word, offset) => words[i + offset] === word))
    if (!phrase) return false
    i += phrase.length
  }
  return true
}
