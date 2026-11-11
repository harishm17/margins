/**
 * The teach-back eval's side of the parity check (spec §11). The eval (evals/tutoring/teach_eval.py) plays scripted
 * students against the voice coach and answers the coach's tool calls from a Python mirror of this code: the probe rules
 * (teach-back.ts) and what the tools return for an assessment (teach-tools.ts). This file replays the committed scenarios
 * through the real functions and also renders the coach's prompt and tool definitions, so the mirror and the prompt the
 * eval sends can be checked against the app. See eval-parity.test.ts and scripts/teach-parity-fixture.ts.
 */
import { buildCoachSystemPrompt, startMessage } from '@/lib/voice/coach-prompt'
import { selectCourseTerms } from '@/lib/voice/course-terms'
import { assessmentResult, exampleResult } from '@/lib/voice/teach-tools'
import { assembledReply, type ReplyFacts } from '@/lib/voice/assembled-reply'
import { emptyConceptState, type AssessedClaim, type ConceptState, type Gap, type Plan, type ProbeKind } from '@/lib/voice/teach-back'
import { toolsForStyle } from '@/lib/voice/tools'
import { appResultBlock, exampleCheckStep } from '@/lib/voice/pre-run'
import { promptsV2 } from '@/lib/prompt-revision'
import { FINISH_CUT_OFF_NOTE, MAX_HISTORY_MESSAGES, STEPPED_HIGH, STEPPED_LOW } from '@/lib/voice/history'
import { asksForHelp, classifyUtterance, hasSubstance, UTTERANCE_RULES } from '@/lib/voice/utterance'
import { CORE_WORDS, FILLER, LOW_EFFORT, REQUEST_WORDS } from '@/lib/learning/dont-know'
import type { Band } from '@/lib/learning/level'

type Verdict = {
  verdict: AssessedClaim['verdict']
  student_quote: string | null
  misconception: string | null
  pointer: string | null
  reasoning_gap?: boolean | null
}

type TeachConcept = { id: string; name: string; prerequisite: string | null; claims: { id: string; text: string; page: number | null }[] }
type TeachTurn = { kind: 'explain' | 'example'; say: string; verdicts: Verdict[]; dont_know?: boolean }

export type TeachScenario = {
  id: string
  topic: string
  concept: TeachConcept
  /** The support band of the concept (no database here to compute it); core when absent. */
  band?: Band
  turns: TeachTurn[]
  /** The ideas that follow the first in the same session, each with its own turns (a session of more than one idea). */
  then?: { concept: TeachConcept; turns: TeachTurn[] }[]
}

/** The idea that follows in the fixture's closing turns (teach_state.py PARITY_NEXT_IDEA). */
const PARITY_NEXT_IDEA = { done: false, prompt: 'Explain "the next idea" in your own words, as if you were teaching it to a classmate.' } as const

/** The ideas of a scenario in order: its own concept and turns, then each entry of `then`. */
export const ideasOf = (scenario: TeachScenario): { concept: TeachConcept; turns: TeachTurn[] }[] => [
  { concept: scenario.concept, turns: scenario.turns },
  ...(scenario.then ?? []),
]

const claimsOf = (concept: TeachConcept, verdicts: Verdict[]): AssessedClaim[] =>
  concept.claims.map((claim, index) => ({
    claimId: claim.id,
    text: claim.text,
    page: claim.page,
    verdict: verdicts[index].verdict,
    studentQuote: verdicts[index].student_quote,
    misconception: verdicts[index].misconception,
    pointer: verdicts[index].pointer,
    reasoningGap: verdicts[index].reasoning_gap ?? null,
  }))

/**
 * Each scenario's turns through the real assessment and example functions, idea after idea, each until it closes. The
 * functions read the voice flag themselves (the tags, the confront example, the name of the example check), so the
 * fixture of each revision is written with PROMPTS_V2 set for it (scripts/teach-parity-fixture.ts).
 */
export function teachParityFixture(scenarios: TeachScenario[]) {
  const v2 = promptsV2('voice')
  return scenarios.map((scenario) => {
    const steps: { kind: string; output: Record<string, unknown>; state: ConceptState; app_result: unknown; spoken: string | null; spoken_then?: string | null }[] = []
    // The reply the app would say itself (null where the coach model words it). A closing turn is said two ways: after the
    // last idea, and with another to open.
    const said = (facts: Omit<ReplyFacts, 'next'>) => ({
      spoken: assembledReply({ ...facts, next: { done: true } }),
      ...(facts.plan.action === 'wrap_up' ? { spoken_then: assembledReply({ ...facts, next: PARITY_NEXT_IDEA }) } : {}),
    })
    for (const idea of ideasOf(scenario)) {
      let state: ConceptState = emptyConceptState()
      for (const turn of idea.turns) {
        if (state.outcome) break
        const claims = claimsOf(idea.concept, turn.verdicts)
        if (turn.kind === 'explain') {
          const coveredSomething = claims.some((claim) => claim.verdict === 'covered' || claim.verdict === 'partial')
          const prerequisite = coveredSomething ? null : idea.concept.prerequisite
          const next = assessmentResult(idea.concept.name, claims, state, prerequisite, {
            dontKnow: turn.dont_know === true,
            band: scenario.band ?? 1,
          })
          state = next.state
          steps.push({
            kind: 'explain',
            output: next.output,
            state,
            app_result: appResultBlock('assess_explanation', next.output).text,
            ...said({ plan: next.plan, claims, prerequisite, turn: state.assessments, dontKnow: turn.dont_know === true, outcome: state.outcome, lookAgain: next.lookAgain }),
          })
        } else {
          const next = exampleResult(idea.concept.name, claims, state)
          state = next.state
          steps.push({
            kind: 'example',
            output: next.output,
            state,
            app_result: appResultBlock('record_check', next.output, exampleCheckStep(v2)).text,
            ...said({ plan: next.plan, claims, prerequisite: null, turn: state.assessments, outcome: state.outcome, examplePassed: next.passed }),
          })
        }
      }
    }
    return { id: scenario.id, steps }
  })
}

const courseTermsOf = (scenarios: TeachScenario[]) => {
  const concepts = new Map(scenarios.flatMap((scenario) => ideasOf(scenario).map((idea) => [idea.concept.id, idea.concept] as const)))
  return selectCourseTerms({
    conceptNames: [...concepts.values()].map((concept) => concept.name),
    claimTexts: [...concepts.values()].flatMap((concept) => concept.claims.map((claim) => claim.text)),
  })
}

/** The coach's prompt and start message for each topic of the scenarios, and the tools it is given. */
export function teachPromptFixture(scenarios: TeachScenario[], v2 = false) {
  const topics = [...new Set(scenarios.map((scenario) => scenario.topic))].sort()
  return {
    topics: Object.fromEntries(
      topics.map((topic) => [
        topic,
        {
          system: buildCoachSystemPrompt({
            mode: 'topic_drill',
            style: 'teach_back',
            language: 'en',
            topicName: topic,
            // The app lists the topic's key terms in the prompt (spec 19.5): the concepts of the scenarios on this topic and their claims.
            courseTerms: courseTermsOf(scenarios.filter((scenario) => scenario.topic === topic)),
            v2,
          }),
          start: startMessage('teach_back', topic, v2),
        },
      ])
    ),
    tools: toolsForStyle('teach_back', v2),
    // How much of the conversation the app keeps between turns (history.ts toStoredHistory); the eval trims as the app does.
    history: v2 ? { high: STEPPED_HIGH, low: STEPPED_LOW } : { max: MAX_HISTORY_MESSAGES },
    // v2: what the turn loop says to the model after a reply that stopped at its token limit (turn-engine.ts).
    ...(v2 ? { finish_cut_off_note: FINISH_CUT_OFF_NOTE } : {}),
  }
}

/**
 * Replies the scenarios do not reach, for both builders (assembled-reply.ts and teach_state.py `assembled_reply`): a real
 * grader question, the pointers that are not one question, the turns left to the coach model, and each closing line.
 */
const REPLY_CLAIMS = { open: 'Chaining keeps a list in each bucket.', held: 'Two keys that share a bucket collide.' } as const
const replyClaims = (verdict: AssessedClaim['verdict'], extra: Partial<AssessedClaim> = {}, held: AssessedClaim['verdict'] = 'covered'): AssessedClaim[] => [
  { claimId: 'k1', text: REPLY_CLAIMS.held, page: 4, verdict: held, studentQuote: held === 'covered' ? 'two keys in one bucket collide' : null },
  { claimId: 'k2', text: REPLY_CLAIMS.open, page: 5, verdict, ...extra },
]
const probeOn = (finding: Gap['finding'], probeNumber = 1, page = 5): Plan => ({ action: 'probe', gap: { claimId: 'k2', finding, page }, probe: { probe: 'implication', label: '' } as ProbeKind, probeNumber })
const THEN: ReplyFacts['next'] = { done: false, prompt: 'Explain "Load factor" in your own words, as if you were teaching it to a classmate.' }
const QUESTION = 'What does each bucket hold?'
const REPLY_CASES: { name: string; facts: ReplyFacts }[] = [
  { name: 'missing claim, grader question, part already covered', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: `Look again at p. 5: ${QUESTION}` }), prerequisite: null, turn: 1 } },
  { name: 'missing claim, grader question, nothing covered yet', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: `Look again at p. 5: ${QUESTION}` }, 'missing'), prerequisite: null, turn: 1 } },
  { name: 'the question names its page itself', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: 'Look again at p. 5: What does page 5 say each bucket holds?' }), prerequisite: null, turn: 1 } },
  { name: 'a pointer with no page', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: `Look again in your reading: ${QUESTION}` }), prerequisite: null, turn: 1 } },
  { name: 'a pointer that only names the idea', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: 'Look again at p. 5: Chaining' }), prerequisite: null, turn: 1 } },
  { name: 'a pointer holding two questions', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: 'Look again at p. 5: What does each bucket hold? Why a list?' }), prerequisite: null, turn: 1 } },
  { name: 'two questions joined in one sentence', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: 'Look again at p. 5: Where does a new key land at first, and what must happen when the bucket is taken?' }), prerequisite: null, turn: 1 } },
  { name: 'a question that names its answers', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: 'Look again at p. 5: Does a bucket hold one key or several?' }), prerequisite: null, turn: 1 } },
  { name: 'a yes-or-no question with a condition in it', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: 'Look again at p. 5: If the table is full and a key arrives, is there still room for it?' }), prerequisite: null, turn: 1 } },
  { name: 'a question too long to say', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: `Look again at p. 5: ${'When a key arrives '.repeat(8)}what happens?` }), prerequisite: null, turn: 1 } },
  { name: 'a leading question that says the claim', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { pointer: "Look again at p. 5: Isn't it that chaining keeps a list in each bucket?" }), prerequisite: null, turn: 1 } },
  { name: 'loose claim, a leading question, a short quote', facts: { plan: probeOn('vague'), claims: replyClaims('partial', { pointer: 'Look again at p. 5: Does chaining keep a list in each bucket?', studentQuote: 'it keeps stuff' }), prerequisite: null, turn: 1 } },
  { name: 'loose claim, grader question', facts: { plan: probeOn('vague'), claims: replyClaims('partial', { pointer: `Look again at p. 5: ${QUESTION}`, studentQuote: 'it keeps stuff' }), prerequisite: null, turn: 1 } },
  { name: 'loose claim, no question, a long quote', facts: { plan: probeOn('vague'), claims: replyClaims('partial', { studentQuote: 'the bucket '.repeat(9) }), prerequisite: null, turn: 1 } },
  { name: 'wrong claim', facts: { plan: probeOn('incorrect'), claims: replyClaims('incorrect', { studentQuote: 'the table doubles', pointer: `Look again at p. 5: ${QUESTION}` }), prerequisite: null, turn: 1 } },
  { name: 'second probe on the same gap', facts: { plan: probeOn('missing', 2), claims: replyClaims('missing', { pointer: `Look again at p. 5: ${QUESTION}` }), prerequisite: null, turn: 2 } },
  // The grader's question written for the ear (`probe`, a grade asked for with `spoken`).
  { name: 'missing claim, a spoken question', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { probe: QUESTION, pointer: `Look again at p. 5: ${QUESTION}` }), prerequisite: null, turn: 1 } },
  { name: 'wrong claim, a spoken question, their words', facts: { plan: probeOn('incorrect'), claims: replyClaims('incorrect', { studentQuote: 'the table doubles', probe: 'Where does a second key with the same index go?' }), prerequisite: null, turn: 1 } },
  { name: 'wrong claim, a spoken question, a long quote', facts: { plan: probeOn('incorrect'), claims: replyClaims('incorrect', { studentQuote: 'the bucket '.repeat(9), probe: 'Where does a second key with the same index go?' }), prerequisite: null, turn: 1 } },
  { name: 'wrong claim, a spoken question joining two', facts: { plan: probeOn('incorrect'), claims: replyClaims('incorrect', { studentQuote: 'the table doubles', probe: 'Where does the second key go, and why does that work?' }), prerequisite: null, turn: 1 } },
  { name: 'two questions joined, the first a yes or no', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { probe: 'Is the bucket empty, and what happens if it is not?' }), prerequisite: null, turn: 1 } },
  { name: 'one question with a which clause inside', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { probe: 'What goes wrong when you swap which key is stored and which is looked up?' }), prerequisite: null, turn: 1 } },
  { name: 'a spoken question that says the claim', facts: { plan: probeOn('missing'), claims: replyClaims('missing', { probe: 'Does chaining keep a list in each bucket?' }), prerequisite: null, turn: 1 } },
  { name: 'second probe, a new spoken question', facts: { plan: probeOn('missing', 2), claims: replyClaims('missing', { probe: 'Two keys land on index 3: where is the second one stored?' }), prerequisite: null, turn: 2, asked: [QUESTION] } },
  { name: 'second probe, the question already asked', facts: { plan: probeOn('missing', 2), claims: replyClaims('missing', { probe: 'What does each bucket hold then?' }), prerequisite: null, turn: 2, asked: [QUESTION] } },
  { name: 'second probe on a wrong claim, a new spoken question', facts: { plan: probeOn('incorrect', 2), claims: replyClaims('incorrect', { studentQuote: 'the table doubles', probe: 'Two keys land on index 3: where is the second one stored?' }), prerequisite: null, turn: 3, asked: ['Where does a second key with the same index go?'] } },
  { name: 'a quote with quotation marks in it', facts: { plan: probeOn('unsupported_jump'), claims: replyClaims('covered', { studentQuote: '"each bucket" keeps a "list".' }), prerequisite: null, turn: 1 } },
  { name: 'a quote with a question in it', facts: { plan: probeOn('unsupported_jump'), claims: replyClaims('covered', { studentQuote: 'is it a list? or a tree' }), prerequisite: null, turn: 1 } },
  { name: 'a prerequisite named with a full stop, page 0', facts: { plan: probeOn('missing_prerequisite', 1, 0), claims: replyClaims('missing', {}, 'missing'), prerequisite: ' Hash  functions. ', turn: 1 } },
  { name: 'a prerequisite named as a question', facts: { plan: probeOn('missing_prerequisite'), claims: replyClaims('missing', {}, 'missing'), prerequisite: 'What is a hash function?', turn: 1 } },
  { name: 'a claim on page 0', facts: { plan: { action: 'explain', gap: { claimId: 'k2', finding: 'missing', page: 0 } }, claims: replyClaims('missing', { page: 0 }), prerequisite: null, turn: 3 } },
  { name: 'a claim worded as a question', facts: { plan: { action: 'explain', gap: { claimId: 'k2', finding: 'missing', page: 5 } }, claims: replyClaims('missing', { text: 'What does chaining keep in each bucket?' }), prerequisite: null, turn: 3 } },
  { name: 'the next idea is named as a question', facts: { plan: { action: 'wrap_up' }, claims: replyClaims('covered'), prerequisite: null, turn: 2, outcome: 'explained', next: { done: false, prompt: 'Explain "Why hash?" in your own words, as if you were teaching it to a classmate.' } } },
  { name: 'a claim too long to say', facts: { plan: { action: 'explain', gap: { claimId: 'k2', finding: 'missing', page: 5 } }, claims: replyClaims('missing', { text: 'Chaining keeps a list. '.repeat(16) }), prerequisite: null, turn: 3 } },
  { name: 'asked to be told', facts: { plan: { action: 'explain_first', gap: { claimId: 'k2', finding: 'missing', page: 5 } }, claims: replyClaims('missing'), prerequisite: null, turn: 2, told: true } },
  { name: 'closed after an explanation, two pages, another idea follows', facts: { plan: { action: 'wrap_up' }, claims: replyClaims('covered'), prerequisite: null, turn: 4, outcome: 'taught', lookAgain: ['p. 5', 'pp. 4-5', 'p. 4'], next: THEN } },
  { name: 'closed with a claim still open', facts: { plan: { action: 'wrap_up' }, claims: replyClaims('missing'), prerequisite: null, turn: 4, outcome: 'taught', lookAgain: ['p. 5'], next: THEN } },
  { name: 'the new example was passed on the last idea', facts: { plan: { action: 'wrap_up' }, claims: replyClaims('missing'), prerequisite: null, turn: 2, outcome: 'explained', examplePassed: true, next: { done: true } } },
  { name: 'a closing turn with nothing known to follow', facts: { plan: { action: 'wrap_up' }, claims: replyClaims('covered'), prerequisite: null, turn: 2, outcome: 'explained' } },
]

/** Each case's facts and the reply the app builds for them (null: the coach model words the turn). */
export function assembledReplyFixture() {
  return REPLY_CASES.map((entry) => ({ ...entry, reply: assembledReply(entry.facts) }))
}

/** Extra utterances for the classifier fixture: each kind of non-answer, and the near misses. */
export const UTTERANCE_CASES = [
  'stop', 'skip this one', 'next question', "I'm done", 'can we stop', "that's all for now",
  "I don't know", 'idk', 'no idea', 'no clue', "I don't remember",
  'repeat that', 'say that again', 'slower', 'pardon', 'sorry?', 'what was the question', 'hint', 'can I get a hint', "I'm stuck",
  'just tell me', 'what is the answer', 'can you explain it', 'okay', 'let me think', 'hold on', 'what do you mean by bucket',
  'is it the second one?', 'why does that matter', 'um', '', 'the mean', 'true', 'yes', 'no',
  'a hash function maps a key to a bucket index', 'Maybe the table grows when it is full?',
  'how a hash table works is that it stores keys in buckets and looks them up by hash',
  'the next bucket is checked when the first one is full so the search does not stop',
]

/** How the rules read each scenario utterance and the extra cases, and the tables the Python mirror builds its patterns from. */
export function utteranceFixture(scenarios: TeachScenario[]) {
  const texts = [...new Set([...scenarios.flatMap((scenario) => ideasOf(scenario).flatMap((idea) => idea.turns.map((turn) => turn.say))), ...UTTERANCE_CASES])]
  return {
    rules: { ...UTTERANCE_RULES, low_effort: [...LOW_EFFORT], filler: [...FILLER], request_words: [...REQUEST_WORDS], core_words: [...CORE_WORDS] },
    cases: texts.map((text) => {
      const kind = classifyUtterance(text)
      return { text, kind, substance: hasSubstance(text, kind), help: asksForHelp(text) }
    }),
  }
}
