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
import { emptyConceptState, type AssessedClaim, type ConceptState } from '@/lib/voice/teach-back'
import { toolsForStyle } from '@/lib/voice/tools'
import { appResultBlock } from '@/lib/voice/pre-run'
import { classifyUtterance, hasSubstance, UTTERANCE_RULES } from '@/lib/voice/utterance'
import { CORE_WORDS, FILLER, LOW_EFFORT, REQUEST_WORDS } from '@/lib/learning/dont-know'
import type { Band } from '@/lib/learning/level'

type Verdict = {
  verdict: AssessedClaim['verdict']
  student_quote: string | null
  misconception: string | null
  pointer: string | null
  reasoning_gap?: boolean | null
}

export type TeachScenario = {
  id: string
  topic: string
  concept: { id: string; name: string; prerequisite: string | null; claims: { id: string; text: string; page: number | null }[] }
  /** The support band of the concept (no database here to compute it); core when absent. */
  band?: Band
  turns: { kind: 'explain' | 'example'; say: string; verdicts: Verdict[]; dont_know?: boolean }[]
}

const claimsOf = (scenario: TeachScenario, verdicts: Verdict[]): AssessedClaim[] =>
  scenario.concept.claims.map((claim, index) => ({
    claimId: claim.id,
    text: claim.text,
    page: claim.page,
    verdict: verdicts[index].verdict,
    studentQuote: verdicts[index].student_quote,
    misconception: verdicts[index].misconception,
    pointer: verdicts[index].pointer,
    reasoningGap: verdicts[index].reasoning_gap ?? null,
  }))

/** Each scenario's turns through the real assessment and example functions, until the idea closes. */
export function teachParityFixture(scenarios: TeachScenario[]) {
  return scenarios.map((scenario) => {
    let state: ConceptState = emptyConceptState()
    const steps: { kind: string; output: Record<string, unknown>; state: ConceptState; app_result: unknown }[] = []
    for (const turn of scenario.turns) {
      if (state.outcome) break
      const claims = claimsOf(scenario, turn.verdicts)
      if (turn.kind === 'explain') {
        const coveredSomething = claims.some((claim) => claim.verdict === 'covered' || claim.verdict === 'partial')
        const next = assessmentResult(scenario.concept.name, claims, state, coveredSomething ? null : scenario.concept.prerequisite, {
          dontKnow: turn.dont_know === true,
          band: scenario.band ?? 1,
        })
        state = next.state
        steps.push({ kind: 'explain', output: next.output, state, app_result: appResultBlock('assess_explanation', next.output).text })
      } else {
        const next = exampleResult(scenario.concept.name, claims, state)
        state = next.state
        steps.push({ kind: 'example', output: next.output, state, app_result: appResultBlock('record_check', next.output).text })
      }
    }
    return { id: scenario.id, steps }
  })
}

const courseTermsOf = (scenarios: TeachScenario[]) => {
  const concepts = new Map(scenarios.map((scenario) => [scenario.concept.id, scenario.concept]))
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
          start: startMessage('teach_back', topic),
        },
      ])
    ),
    tools: toolsForStyle('teach_back', v2),
  }
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
  const texts = [...new Set([...scenarios.flatMap((scenario) => scenario.turns.map((turn) => turn.say)), ...UTTERANCE_CASES])]
  return {
    rules: { ...UTTERANCE_RULES, low_effort: [...LOW_EFFORT], filler: [...FILLER], request_words: [...REQUEST_WORDS], core_words: [...CORE_WORDS] },
    cases: texts.map((text) => {
      const kind = classifyUtterance(text)
      return { text, kind, substance: hasSubstance(text, kind) }
    }),
  }
}
