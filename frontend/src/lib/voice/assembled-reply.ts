/**
 * The coach's reply to a graded teach-back turn, put together by the app (docs/design/DECISIONS.md, "Pipeline redesign",
 * decision 6). Pure: no database, no network, no flag read inside `assembledReply`.
 *
 * After a graded turn the app already holds everything the reply needs: the move (teach-back.ts `planNext`), the claim it
 * may say, the page, the student's own words, the grader's question for a claim they left out and the next idea. The
 * small model was only turning that into a sentence, and that call is what the student waits for after the grader. Here
 * the reply is built from those parts, so the turn makes no model call.
 *
 * It returns null wherever fixed wording would be worse than the model's, and the coach model then speaks as before:
 *   - a probe on a wrong claim (the question has to be made for what this student got wrong);
 *   - the second probe on a gap (the first wording has been used; a smaller question has to be written);
 *   - the new example (written by the model until the topic's bank holds one);
 *   - a missing or loose claim with no usable question from the grader, a long quote, a long claim.
 *
 * Maths is left as written: the browser turns notation into spoken words (speakable.ts).
 *
 * The eval's Python mirror is `assembled_reply` in evals/tutoring/teach_state.py, pinned by the parity fixture.
 */
import type { AssessedClaim, Plan } from '@/lib/voice/teach-back'

/** VOICE_GRADER_LED=true: graded teach-back turns are answered with the reply built here when one can be built. Off by default. */
export const graderLedVoice = (): boolean => process.env.VOICE_GRADER_LED === 'true'

export type SpokenNext = { done: true } | { done: false; prompt: string }

export type ReplyFacts = {
  plan: Plan
  claims: AssessedClaim[]
  /** The weak prerequisite's name, for a `missing_prerequisite` probe. */
  prerequisite: string | null
  /** Assessments of the idea so far, this one included. It only picks between wordings, so one line is not said every turn. */
  turn: number
  /** The student said "I don't know" (not a request to be told). */
  dontKnow?: boolean
  /** The student asked to be told and the app agreed (teach-tools.ts `told`). */
  told?: boolean
  /** For a closing turn: how the idea closed, the pages to look at again ("p. 4"), whether a new example was just passed, and what follows. */
  outcome?: 'explained' | 'taught' | null
  lookAgain?: string[]
  examplePassed?: boolean
  next?: SpokenNext | null
}

const MAX_QUOTE_WORDS = 16
const MAX_QUESTION_WORDS = 30
const MAX_CLAIM_WORDS = 60

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length
const pick = (options: readonly string[], turn: number): string => options[Math.abs(Math.trunc(turn)) % options.length]

const SAY_BACK = ['Can you say that back in your own words?', 'How would you put that in your own words?'] as const
const FINE_NOT_TO_KNOW = ["That's fine, no need to have it yet.", "That's okay, this one takes a while to stick."] as const
const LAST_IDEA = 'That was the last idea for this topic. Good work, and goodbye.'

/**
 * The question inside a grader pointer ("Look again at p. 14: What does the ratio compare?") and its page. Null when the
 * pointer only names the idea (the grader's fallback), holds more than one question, or is too long to say.
 */
export function pointerQuestion(pointer: string | null | undefined): { question: string; page: number | null } | null {
  const match = /^Look again (?:at p\. ([0-9]{1,5})|in your reading):\s*([\s\S]+)$/.exec((pointer ?? '').trim())
  if (!match) return null
  const question = match[2].trim()
  if (!question.endsWith('?') || question.indexOf('?') !== question.length - 1 || wordCount(question) > MAX_QUESTION_WORDS) return null
  if (joinedOrEitherOr(question)) return null
  return { question, page: realPage(match[1] ? Number(match[1]) : null) }
}

// The form rule of the eval's question gate (evals/tutoring/teach_metrics.py `question_form`), in the same patterns.
const AUXILIARY = '(?:is|are|was|were|does|do|did|would|will|can|could|should|has|have)'
const JOINED = new RegExp(`\\b(?:and|or|but)\\s+(?:then\\s+)?(?:what|why|how|who|${AUXILIARY})\\b`, 'i')
const ASKS = new RegExp(`\\b(?:what|why|how|who|which|where)\\b|(?:^|[,;:]\\s+)(?:(?:so|and|but|then|now)\\s+)?${AUXILIARY}\\b`, 'i')
const YES_NO = new RegExp(`(?:^|[,;:]\\s+)(?:(?:so|and|but|then|now)\\s+)?(${AUXILIARY})\\s+(\\w+)`, 'gi')
const REQUEST = /^(?:can|could|would|will)\s+you$|^(?:do|would)\s+you$/i
const OR = /\bor\b/i

/**
 * Two questions joined in one sentence ("where does it go, and what must happen next?"), or a question that names its
 * answers ("does a bucket hold a list or one key?"). Nearly half of the grader's questions were of the first kind when
 * its stored output was read (2026-11-10); a student answering aloud can hold one question.
 */
export function joinedOrEitherOr(question: string): boolean {
  const joined = JOINED.exec(question)
  if (joined && ASKS.test(question.slice(0, joined.index))) return true
  let closed: RegExpMatchArray | null = null
  for (const match of question.matchAll(YES_NO)) {
    if (!REQUEST.test(`${match[1]} ${match[2]}`)) closed = match
  }
  if (closed) return OR.test(question.slice((closed.index ?? 0) + closed[0].length))
  return /\bwhich\b/i.test(question) && OR.test(question)
}

/** A page that can be named: pages count from 1. */
const realPage = (page: number | null | undefined): number | null => (typeof page === 'number' && page > 0 ? page : null)

const contentWords = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 4)

/**
 * Whether a question says the claim it is meant to draw out ("Isn't it that chaining keeps a list in each bucket?"): most
 * of the claim's longer words are in it. The coach's prompt kept such a pointer from being read out; here nothing else does.
 */
export function givesAway(question: string, claim: string | null | undefined): boolean {
  const words = [...new Set(contentWords(claim ?? ''))]
  if (words.length < 3) return false
  const asked = new Set(contentWords(question))
  return words.filter((word) => asked.has(word)).length / words.length >= 0.6
}

/**
 * The student's words as they can be said back inside a sentence, or null when there are none or too many. Double quotes
 * inside them are dropped: the reply puts its own pair around the words, and a mark is not spoken.
 */
function quoted(quote: string | null | undefined): string | null {
  const text = (quote ?? '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['‘’]+|['‘’.,;:!?]+$/g, '')
    .trim()
  // A question inside the quote would make the reply two questions.
  return text && !text.includes('?') && wordCount(text) <= MAX_QUOTE_WORDS ? text : null
}

/** A claim as one spoken statement, or null when it is empty, too long to say in one go, or worded as a question. */
function statement(text: string | null | undefined): string | null {
  const claim = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!claim || claim.includes('?') || wordCount(claim) > MAX_CLAIM_WORDS) return null
  return /[.!]$/.test(claim) ? claim : `${claim}.`
}

/** A concept's name as it sits inside a sentence, or null when there is none or it holds a question mark. */
function named(name: string | null | undefined): string | null {
  const text = (name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!]+$/, '')
    .trim()
  return text && !text.includes('?') ? text : null
}

/** "Think about page 4. " before a question that does not name its page itself. */
const pageLead = (page: number | null, question: string): string => (page !== null && !/\bpage\b|\bp\.\s*[0-9]/i.test(question) ? `Think about page ${page}. ` : '')

function pagesLine(lookAgain: readonly string[] | undefined): string | null {
  const pages = [...new Set((lookAgain ?? []).map((entry) => Number(/[0-9]+/.exec(entry)?.[0])).filter((page) => Number.isInteger(page) && page > 0))].sort((a, b) => a - b)
  if (pages.length === 0) return null
  if (pages.length === 1) return `Page ${pages[0]} is worth another look.`
  return `Pages ${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]} are worth another look.`
}

function probeReply(facts: ReplyFacts, plan: Extract<Plan, { action: 'probe' }>): string | null {
  // The second probe on a gap must be a smaller question than the first: that is written, not looked up.
  if (plan.probeNumber !== 1) return null
  const claim = facts.claims.find((entry) => entry.claimId === plan.gap.claimId)
  const page = realPage(plan.gap.page)
  // The grader's question, unless it says the claim it is asking for.
  const asked = () => {
    const pointer = pointerQuestion(claim?.pointer)
    return pointer && !givesAway(pointer.question, claim?.text) ? pointer : null
  }
  switch (plan.gap.finding) {
    case 'incorrect':
      return null
    case 'missing_prerequisite': {
      const name = named(facts.prerequisite)
      return name ? `Let's step back for a moment. How would you describe ${name} in your own words?` : null
    }
    case 'unsupported_jump': {
      const said = quoted(claim?.studentQuote)
      return said ? `You said, "${said}". What ${page !== null ? `on page ${page} of your notes` : 'in your notes'} tells you that?` : null
    }
    case 'missing': {
      const pointer = asked()
      if (!pointer) return null
      const hasSomething = facts.claims.some((entry) => entry.verdict === 'covered' || entry.verdict === 'partial')
      return `${hasSomething ? 'You have part of it.' : "Let's try another piece of it."} ${pageLead(pointer.page, pointer.question)}${pointer.question}`
    }
    case 'vague': {
      const pointer = asked()
      if (pointer) return `You're close on one part. ${pageLead(pointer.page, pointer.question)}${pointer.question}`
      const said = quoted(claim?.studentQuote)
      return said ? `When you say "${said}", what exactly do you mean?` : null
    }
  }
}

function explainReply(facts: ReplyFacts, plan: Extract<Plan, { action: 'explain' | 'explain_first' }>): string | null {
  const claim = facts.claims.find((entry) => entry.claimId === plan.gap.claimId)
  const said = statement(claim?.text)
  if (!said) return null
  const page = realPage(claim?.page)
  const from = `Here is what your notes say${page !== null ? ` on page ${page}` : ''}: ${said}`
  const sayBack = pick(SAY_BACK, facts.turn)
  if (plan.action === 'explain') return `${from} ${sayBack}`
  const opening = facts.told ? 'No problem.' : facts.dontKnow ? pick(FINE_NOT_TO_KNOW, facts.turn) : "That's okay, let's start from your notes."
  return `${opening} ${from} ${sayBack}`
}

function closingReply(facts: ReplyFacts): string | null {
  if (!facts.next) return null
  // The next idea's prompt is the one question-shaped line of a closing turn: without it, or with a question mark in it
  // (a concept named as a question), the coach model words the turn.
  const prompt = facts.next.done ? '' : facts.next.prompt.replace(/\s+/g, ' ').trim()
  if (!facts.next.done && (!prompt || prompt.includes('?'))) return null
  const allCovered = facts.claims.length > 0 && facts.claims.every((claim) => claim.verdict === 'covered')
  // Never praise what was not shown: only a passed example or every claim covered is called right.
  const verdict = facts.examplePassed ? 'Yes, that works.' : allCovered ? (facts.outcome === 'taught' ? "That's it, you have it now." : "Yes, that's right.") : "Let's leave that one there for now."
  const parts = [verdict, facts.outcome === 'taught' ? pagesLine(facts.lookAgain) : null, facts.next.done ? LAST_IDEA : `Next idea. ${prompt}`]
  return parts.filter(Boolean).join(' ')
}

/** The reply to say for this step, or null when the coach model should word it. */
export function assembledReply(facts: ReplyFacts): string | null {
  const plan = facts.plan
  switch (plan.action) {
    case 'probe':
      return probeReply(facts, plan)
    case 'explain':
    case 'explain_first':
      return explainReply(facts, plan)
    case 'wrap_up':
      return closingReply(facts)
    case 'ask_new_example':
      return null
  }
}
