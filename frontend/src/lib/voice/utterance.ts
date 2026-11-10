/**
 * What a student utterance is, decided by rule before any model call (spec §19.1). Pure, so the tutoring eval's Python
 * mirror (evals/tutoring/utterance.py) can be pinned to it by a fixture.
 *
 * The order is: control (stop, skip, next), a request for help (a hint, the answer), "I don't know" (`isDontKnow`, the
 * one detector), a meta request or question (repeat, slower, a question back to the coach), and otherwise an answer.
 * Only an answer or an "I don't know" lets the server run the session's waiting step before the model speaks; anything
 * else goes to the model with its tools, as before. When the rules are unsure the utterance is not an answer: a
 * wrongly skipped pre-run costs a second model call, a wrong one would record something the student did not say.
 */
import { isDontKnow, normalize } from '@/lib/learning/dont-know'

export type UtteranceKind = 'control' | 'idk' | 'meta' | 'answer'

const words = (text: string) => normalize(text).split(' ').filter(Boolean)

/** Stop, skip, next, done: the student steers the session. Short only, so an explanation that says "next" is not one. */
const CONTROL = [
  /^(please |ok |okay |can we |lets |let us |i want to |i wanna )?(stop|skip|quit|exit|pause|end|finish)( this| it| here| now| the session| the quiz| the drill| for now| please)*$/,
  /^(please |ok |okay |ok so )?(next|next one|next question|next claim|next idea|move on|lets move on|go on|go to the next( one| question| claim)?|skip this( one| question| claim)?)( please)?$/,
  /^(im|i am) (done|finished|good)( for now| for today| here)?$/,
  /^(thats|that is) (all|it|enough)( for now| for today)?$/,
  /^(lets|let us|can we) (stop|end|finish|move on|skip)( here| now| for now| this)?$/,
  /^(i )?(want|need|have) to (stop|go|leave)( now| for now)?$/,
  /^(goodbye|bye|see you)( for now)?$/,
]

/** Asking for a hint, a nudge or the answer itself: the coach decides what to give (get_hint, or one smaller question). */
const HELP = [
  /\b(hint|hints|nudge|stuck|help me|a little help|some help|(a|any|some) clue)\b/,
  /\b(tell|show|give) me (the |an |a )?(answer|solution|claim)\b/,
  /\bjust (tell|show|explain|say) (it|me|this|that)\b/,
  /\b(whats|what is) the (answer|solution)\b/,
  /\bcan you (just )?(tell|explain|show|give)\b/,
  /\b(you|can you|could you|will you|would you) (explain|teach|tell|show)( it| this| that| me)?$/,
  /\bhow (do|would|should) (i|you|we) (start|begin)\b/,
]

/** Repeat, slow down, rephrase, did not hear: no step runs, the model repeats or rewords. */
const REPEAT = [
  /\b(repeat|say (that|it) again|say again|one more time|once more|again please|come again)\b/,
  /\b(slower|slow down|too fast|more slowly|speak up|louder)\b/,
  /\bwhat (was|is|were) (the|that|your) (question|prompt|last)\b/,
  /\b(didnt|did not|couldnt|could not|cant|can not) (hear|catch|understand|get) (that|you|it|the)\b/,
  /\b(rephrase|reword|put it differently|say it differently|what do you mean|i dont understand the question|im confused)\b/,
  /^(sorry|pardon|pardon me|excuse me|huh|what|come again|hm|eh)( what| please)?$/,
]

/** Acknowledgements, thinking out loud and asking for time: nothing was answered. */
const ACKNOWLEDGE = [
  /^(ok|okay|alright|all right|sure|got it|i see|i get it|understood|mm hm|mm|mhm|uh huh|hmm|hm|um|uh|ah|oh|right|thanks|thank you|cool|great|nice|good|fine|ready|go ahead|go on|continue|yes please|yeah ok|yeah okay|okay thanks|ok thanks|lets go|lets do it|lets start|hello|hi|hey)( thanks| thank you| please| sir)?$/,
  /^(hold on|wait|one (second|moment|sec)|give me a (second|moment|sec|minute)|let me think|let me see|let me try|hang on|just a (second|moment|sec|minute)|thinking|im thinking|i need a (second|moment|minute))( please| a (second|moment|sec|minute))?$/,
]

const INTERROGATIVE = /^(what|whats|why|how|when|where|who|which|can|could|do|does|did|is|are|will|would|should|wait|so|and)\b/

/** A short question put back to the coach. A long utterance that starts with "how" is an explanation, and a trailing "?" alone is only uptalk. */
function isQuestionBack(normalized: string): boolean {
  return normalized.split(' ').filter(Boolean).length <= 10 && INTERROGATIVE.test(normalized)
}

/** The tables of the rules, as source text, for the tutoring eval's Python mirror (evals/tutoring/utterance.py reads them from its fixture). */
export const UTTERANCE_RULES = {
  control: CONTROL.map((pattern) => pattern.source),
  help: HELP.map((pattern) => pattern.source),
  repeat: REPEAT.map((pattern) => pattern.source),
  acknowledge: ACKNOWLEDGE.map((pattern) => pattern.source),
  interrogative: INTERROGATIVE.source,
}

/** A short request for a hint or for the answer ("just tell me", "I'm stuck"), and not a word that steers the session. */
export function asksForHelp(text: string): boolean {
  const normalized = normalize(text)
  if (!normalized || CONTROL.some((pattern) => pattern.test(normalized))) return false
  return words(text).length <= 14 && HELP.some((pattern) => pattern.test(normalized))
}

export function classifyUtterance(text: string): UtteranceKind {
  const normalized = normalize(text)
  if (!normalized) return 'meta'
  if (CONTROL.some((pattern) => pattern.test(normalized))) return 'control'
  const count = words(text).length
  // A request for help is a request, however the detector reads it ("hint" alone is an "I don't know" to it).
  if (asksForHelp(text)) return 'meta'
  if (isDontKnow(text)) return 'idk'
  if (count <= 14 && REPEAT.some((pattern) => pattern.test(normalized))) return 'meta'
  if (ACKNOWLEDGE.some((pattern) => pattern.test(normalized))) return 'meta'
  if (isQuestionBack(normalized)) return 'meta'
  return 'answer'
}

/** Utterances worth sending to a grader as an explanation: at least a few words, unless the student said they do not know. */
export function hasSubstance(text: string, kind: UtteranceKind): boolean {
  return kind === 'idk' || (kind === 'answer' && words(text).length >= 3)
}
