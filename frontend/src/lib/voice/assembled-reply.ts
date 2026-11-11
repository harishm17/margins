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
  const match = /^Look again (?:at p\. ([0-9]+)|in your reading):\s*([\s\S]+)$/.exec((pointer ?? '').trim())
  if (!match) return null
  const question = match[2].trim()
  if (!question.endsWith('?') || question.indexOf('?') !== question.length - 1 || wordCount(question) > MAX_QUESTION_WORDS) return null
  return { question, page: match[1] ? Number(match[1]) : null }
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
  return text && wordCount(text) <= MAX_QUOTE_WORDS ? text : null
}

/** A claim as one spoken statement, or null when it is empty or too long to say in one go. */
function statement(text: string | null | undefined): string | null {
  const claim = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!claim || wordCount(claim) > MAX_CLAIM_WORDS) return null
  return /[.!?]$/.test(claim) ? claim : `${claim}.`
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
  const page = plan.gap.page
  switch (plan.gap.finding) {
    case 'incorrect':
      return null
    case 'missing_prerequisite': {
      const name = (facts.prerequisite ?? '').trim()
      return name ? `Let's step back for a moment. How would you describe ${name} in your own words?` : null
    }
    case 'unsupported_jump': {
      const said = quoted(claim?.studentQuote)
      return said ? `You said, "${said}". What ${page !== null ? `on page ${page} of your notes` : 'in your notes'} tells you that?` : null
    }
    case 'missing': {
      const pointer = pointerQuestion(claim?.pointer)
      if (!pointer) return null
      const hasSomething = facts.claims.some((entry) => entry.verdict === 'covered' || entry.verdict === 'partial')
      return `${hasSomething ? 'You have part of it.' : "Let's try another piece of it."} ${pageLead(pointer.page, pointer.question)}${pointer.question}`
    }
    case 'vague': {
      const pointer = pointerQuestion(claim?.pointer)
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
  const from = `Here is what your notes say${claim?.page ? ` on page ${claim.page}` : ''}: ${said}`
  const sayBack = pick(SAY_BACK, facts.turn)
  if (plan.action === 'explain') return `${from} ${sayBack}`
  const opening = facts.told ? 'No problem.' : facts.dontKnow ? pick(FINE_NOT_TO_KNOW, facts.turn) : "That's okay, let's start from your notes."
  return `${opening} ${from} ${sayBack}`
}

function closingReply(facts: ReplyFacts): string | null {
  if (!facts.next) return null
  const allCovered = facts.claims.length > 0 && facts.claims.every((claim) => claim.verdict === 'covered')
  // Never praise what was not shown: only a passed example or every claim covered is called right.
  const verdict = facts.examplePassed ? 'Yes, that works.' : allCovered ? (facts.outcome === 'taught' ? "That's it, you have it now." : "Yes, that's right.") : "Let's leave that one there for now."
  const parts = [verdict, facts.outcome === 'taught' ? pagesLine(facts.lookAgain) : null, facts.next.done ? LAST_IDEA : `Next idea. ${facts.next.prompt.trim()}`]
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
