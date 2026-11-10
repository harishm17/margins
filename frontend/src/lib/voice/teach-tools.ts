/**
 * The tools of the two newer voice styles (spec §5.8), run on the server like the quiz tools in tools.ts.
 *
 * Teach it back: `get_concept_to_explain`, `assess_explanation`, `record_check`.
 *   The explanation goes through the same server function as the written teach-back (`submitRecall`), so the
 *   recall grader, the level rules and the evidence are the written ones: the first explanation of a concept
 *   that day is level 0 with `source=teach_back` and weight 0.7; an explanation after the coach's probes is a
 *   second try after feedback, which is level 2. What the coach may do next (probe, explain, ask a new example)
 *   comes from `teach-back.ts` and the counts kept on the session row, so the model cannot skip the probes. A spoken
 *   "I don't know" (`isDontKnow`) is not graded: it is level 1, score 0, and the first gap is explained at once
 *   (`explain_first`). Every explain step also writes a `voice_explain` instruction event (spec 18.5, 18.6).
 * Guided reading: `next_claim`, `record_check`.
 *   The student predicts before the claim is shown; a check after it is level 2, because the claim was just taught.
 *
 * Every handler returns what the model sees (`output`) and what the browser is told (`events`): the board shows the
 * item the coach is on, from the same result. A claim's text is not in a result until the rules allow it.
 *
 * What the student said is the server's own record, not the model's: the turn route stores each utterance with a
 * turn number (`beginVoiceTurn`), and a tool that takes an answer reads the words spoken after the question was asked.
 * With none, the tool refuses, so an answer cannot be made up, nor taken in the turn that asked the question.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { viewerUrl } from '@/lib/chat/citations'
import { pageLinksOf, type PageLink } from './page-links'
import { pageLabel } from './page-refs'
import type { RecallGradeAnswer, RecallGradeRequest } from '@/lib/ai-service/recall'
import { requestRecallGrade } from '@/lib/ai-service/recall'
import { TutorUnavailableError } from '@/lib/ai-service/tutor'
import { dontKnowEvidence, isDontKnow } from '@/lib/learning/dont-know'
import { recordEvidence } from '@/lib/learning/evidence'
import { recordInstruction } from '@/lib/learning/instruction-server'
import type { Band } from '@/lib/learning/level'
import { lowestBand } from '@/lib/tutor/band-server'
import { conceptMastery, type ConceptKind } from '@/lib/learning/concept-mastery'
import { stateFromMemoryRow } from '@/lib/learning/mastery'
import { recallLevel } from '@/lib/learning/recall-evidence'
import { verdictScore } from '@/lib/learning/recall-scores'
import {
  claimsForGrading,
  conceptTeachBackPrompt,
  loadRecallConcepts,
  submitRecall,
  MAX_RECALL_ANSWER_CHARS,
  type RecallConcept,
  type StoredClaim,
} from '@/lib/learning/recall-server'
import { itemKey } from '@/lib/learning/item-key'
import type { VoiceEvent } from '@/lib/voice/turn-client'
import {
  afterExample,
  emptyConceptState,
  exampleHeld,
  planNext,
  type AssessedClaim,
  type ConceptState,
  type GapOptions,
  type Plan,
  type PlanOptions,
  type Verdict,
} from '@/lib/voice/teach-back'

export type TeachToolContext = {
  sessionId: string
  userId: string
  projectId: string
  topicId: string | null
  /** The student's IANA zone, for the one-review-per-local-day rule. */
  timeZone: string
  /** Replaced by tests; the recall grader of the AI service otherwise. */
  grade?: (request: RecallGradeRequest) => Promise<RecallGradeAnswer>
  /** True when one more model-graded call is allowed now (the per-user limit). */
  allowGrading: () => boolean | Promise<boolean>
  /** The number of the student turn this call belongs to (`beginVoiceTurn`). */
  turn: number
  /** The step runs before the model speaks (spec 19.1): a guided-reading reveal without a check question from the model gets the server's own. */
  autoCheck?: boolean
}

export type TeachToolResult = {
  output: Record<string, unknown>
  events: VoiceEvent[]
  /** The session is finished (every idea explained, or every claim read). */
  sessionComplete?: boolean
}

// ---------------------------------------------------------------------------------------------- session state

type GuidedStage = 'idle' | 'predicting' | 'taught'

/** What the student said in one turn, kept by the server. */
export type Utterance = { turn: number; text: string }

export type CoachState = {
  /** The turns so far: one for each time the student's browser sent the server a turn. */
  turn: number
  /** The last few things the student said, newest last. */
  said: Utterance[]
  /** Oral quiz: the turn of the last question or hint, or of the last answer taken; and the index of the question put last (-1 before the first). */
  quiz: { askedTurn: number; current: number }
  /** `askedTurn`: the turn of the last prompt, probe or question put to the student, or of the last answer taken. */
  teach: { current: string | null; askedTurn: number; concepts: Record<string, ConceptState> }
  guided: { index: number; stage: GuidedStage; prediction: string; checkQuestion: string; askedTurn: number }
}

/** Utterances kept on the session. */
export const SAID_KEPT = 8
const MAX_UTTERANCE_CHARS = 5000

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The state as stored, with anything missing or malformed back at its start. */
export function readCoachState(value: unknown): CoachState {
  const raw = isRecord(value) ? value : {}
  const teach = isRecord(raw.teach) ? raw.teach : {}
  const guided = isRecord(raw.guided) ? raw.guided : {}
  const concepts: Record<string, ConceptState> = {}
  if (isRecord(teach.concepts)) {
    for (const [id, entry] of Object.entries(teach.concepts)) {
      if (!isRecord(entry)) continue
      const gaps: ConceptState['gaps'] = {}
      if (isRecord(entry.gaps)) {
        for (const [claimId, gap] of Object.entries(entry.gaps)) {
          if (isRecord(gap)) gaps[claimId] = { probes: typeof gap.probes === 'number' ? gap.probes : 0, explained: gap.explained === true }
        }
      }
      concepts[id] = {
        assessments: typeof entry.assessments === 'number' ? entry.assessments : 0,
        said: Array.isArray(entry.said) ? entry.said.filter((text): text is string => typeof text === 'string') : [],
        gaps,
        sayBack: typeof entry.sayBack === 'string' ? entry.sayBack : null,
        exampleAsked: entry.exampleAsked === true,
        outcome: entry.outcome === 'explained' || entry.outcome === 'taught' ? entry.outcome : null,
      }
    }
  }
  const stage: GuidedStage = guided.stage === 'predicting' || guided.stage === 'taught' ? guided.stage : 'idle'
  const turnOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : -1)
  const said: Utterance[] = Array.isArray(raw.said)
    ? raw.said.flatMap((entry): Utterance[] => (isRecord(entry) && typeof entry.turn === 'number' && typeof entry.text === 'string' ? [{ turn: entry.turn, text: entry.text }] : []))
    : []
  return {
    turn: typeof raw.turn === 'number' && Number.isFinite(raw.turn) ? raw.turn : 0,
    said,
    quiz: { askedTurn: turnOf(isRecord(raw.quiz) ? raw.quiz.askedTurn : undefined), current: turnOf(isRecord(raw.quiz) ? raw.quiz.current : undefined) },
    teach: { current: typeof teach.current === 'string' ? teach.current : null, askedTurn: turnOf(teach.askedTurn), concepts },
    guided: {
      askedTurn: turnOf(guided.askedTurn),
      index: typeof guided.index === 'number' && guided.index >= 0 ? Math.floor(guided.index) : 0,
      stage,
      prediction: typeof guided.prediction === 'string' ? guided.prediction : '',
      checkQuestion: typeof guided.checkQuestion === 'string' ? guided.checkQuestion : '',
    },
  }
}

export async function saveState(sessionId: string, state: CoachState): Promise<void> {
  await prisma.voiceDrillSession.update({ where: { id: sessionId }, data: { coachState: state as unknown as Prisma.InputJsonValue } })
}

/**
 * Called by the turn route when the student's words arrive: the turn count goes up by one and the words are kept with
 * it. The row is locked for the read and write, so two turns cannot take the same number. Returns the turn's number.
 * An empty `utterance` (the start of a session, "carry on") is a turn with no words.
 */
export async function beginVoiceTurn(sessionId: string, utterance: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM voice_drill_sessions WHERE id = ${sessionId} FOR UPDATE`
    const row = await tx.voiceDrillSession.findUniqueOrThrow({ where: { id: sessionId }, select: { coachState: true } })
    const state = readCoachState(row.coachState)
    state.turn += 1
    const text = utterance.trim().slice(0, MAX_UTTERANCE_CHARS)
    if (text) state.said = [...state.said, { turn: state.turn, text }].slice(-SAID_KEPT)
    await tx.voiceDrillSession.update({ where: { id: sessionId }, data: { coachState: state as unknown as Prisma.InputJsonValue } })
    return state.turn
  })
}

/** What the student has said since turn `since` (exclusive), oldest first: the answer to what was asked in that turn. */
export function heardSince(state: Pick<CoachState, 'said'>, since: number): string {
  return state.said
    .filter((entry) => entry.turn > since)
    .map((entry) => entry.text)
    .join(' ')
    .slice(-MAX_UTTERANCE_CHARS)
}

/** What a tool says when it was called before the student answered. */
export const NOBODY_SPOKE =
  'The student has not said anything since your last question. Ask it, stop, and call this tool only after they have answered.'

async function endSession(sessionId: string): Promise<void> {
  await prisma.voiceDrillSession.update({ where: { id: sessionId }, data: { endedAt: new Date(), status: 'ended' } })
}

const error = (message: string): TeachToolResult => ({ output: { error: message }, events: [] })

const UNAVAILABLE = 'Grading is unavailable right now. Do not give a verdict. Tell the student and offer to try again.'
const TOO_FAST = 'Too many answers too quickly. Wait a moment and try again.'
const NO_TOPIC = 'This session has no topic to work on.'

// ---------------------------------------------------------------------------------------------- shared helpers

/** The verdicts the grader gave, matched to the concept's claims in the claims' own order. A claim it skipped is missing. */
function assessed(concept: RecallConcept, verdicts: Pick<StoredClaim, 'claim_id' | 'verdict' | 'student_quote' | 'misconception' | 'pointer' | 'reasoning_gap'>[]): AssessedClaim[] {
  const byId = new Map(verdicts.map((verdict) => [verdict.claim_id, verdict]))
  return concept.claims.map((claim) => {
    const verdict = byId.get(claim.id)
    return {
      claimId: claim.id,
      text: claim.text,
      page: claim.page,
      verdict: (verdict?.verdict ?? 'missing') as Verdict,
      studentQuote: verdict?.student_quote ?? null,
      misconception: verdict?.misconception ?? null,
      pointer: verdict?.pointer ?? null,
      reasoningGap: verdict?.reasoning_gap ?? null,
    }
  })
}

/** A prerequisite of the concept that the student does not hold yet (retrievability under 0.8, or no memory), by name. */
async function weakPrerequisite(userId: string, conceptId: string, now = new Date()): Promise<string | null> {
  const edges = await prisma.conceptEdge.findMany({
    where: { type: 'prerequisite', status: { not: 'rejected' }, targetId: conceptId },
    select: { sourceId: true },
  })
  if (edges.length === 0) return null
  const ids = edges.map((edge) => edge.sourceId)
  const [concepts, memories] = await Promise.all([
    prisma.concept.findMany({ where: { id: { in: ids }, status: 'active' }, select: { id: true, name: true, kind: true } }),
    prisma.conceptMemory.findMany({ where: { userId, conceptId: { in: ids } } }),
  ])
  const memoryOf = new Map(memories.map((memory) => [memory.conceptId, memory]))
  const scored = concepts.map((concept) => {
    const memory = memoryOf.get(concept.id)
    const retrievability = memory ? conceptMastery(stateFromMemoryRow(memory), concept.kind as ConceptKind, now).retrievability : 0
    return { name: concept.name, retrievability }
  })
  const weak = scored.filter((entry) => entry.retrievability < 0.8).sort((a, b) => a.retrievability - b.retrievability)
  return weak[0]?.name ?? null
}

async function grade(ctx: TeachToolContext, request: RecallGradeRequest): Promise<RecallGradeAnswer> {
  return (ctx.grade ?? requestRecallGrade)(request)
}

const isUnavailable = (failure: unknown) => failure instanceof TutorUnavailableError

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Student words and the pages' claims go into a tool result inside tags, with the angle brackets inside escaped, so the
 * model reads them as data and a sentence that tells it to do something is not one of its instructions (spec 6.5).
 */
export const tagged = (name: 'student_words' | 'source_claim', text: string | null | undefined): string | null => (text ? `<${name}>${escapeText(text)}</${name}>` : null)

/** What the coach is told about the plan: the action, the probe and what it may say. */
export function planOutput(plan: Plan, claims: AssessedClaim[], prerequisite: string | null): Record<string, unknown> {
  switch (plan.action) {
    case 'probe': {
      const claim = claims.find((entry) => entry.claimId === plan.gap.claimId)
      const about =
        plan.gap.finding === 'missing_prerequisite'
          ? prerequisite
          : plan.gap.finding === 'missing'
            ? (claim?.pointer ?? null)
            : tagged('student_words', claim?.studentQuote)
      const pageHelps = plan.gap.finding === 'unsupported_jump' || plan.gap.finding === 'missing_prerequisite' || plan.probe.probe === 'confront'
      return {
        action: 'probe',
        probe: {
          type: plan.probe.probe,
          finding: plan.gap.finding,
          number: plan.probeNumber,
          example: plan.probe.example,
          ...(about ? { about } : {}),
          ...(pageHelps && plan.gap.page !== null ? { page: plan.gap.page } : {}),
        },
      }
    }
    case 'explain': {
      const claim = claims.find((entry) => entry.claimId === plan.gap.claimId)
      return {
        action: 'explain',
        source_claim: { text: tagged('source_claim', claim?.text) ?? '', page: claim?.page ?? null },
        instruction: 'Explain in one or two sentences from source_claim, then ask the student to say it back and call assess_explanation again.',
      }
    }
    case 'explain_first': {
      const claim = claims.find((entry) => entry.claimId === plan.gap.claimId)
      return {
        action: 'explain_first',
        source_claim: { text: tagged('source_claim', claim?.text) ?? '', page: claim?.page ?? null },
        instruction:
          'Say in a few words that it is fine not to have it yet, then explain source_claim in one or two sentences and ask the student to say it back, and call assess_explanation again. Do not ask a probing question first.',
      }
    }
    case 'ask_new_example':
      return {
        action: 'ask_new_example',
        instruction: 'The student covered every claim. Ask one small new example or prediction, then call record_check with their answer.',
      }
    case 'wrap_up':
      return { action: 'wrap_up' }
  }
}

/**
 * What the student said, claim by claim. The text of a claim is never in it: not the one they got wrong, nor one they
 * left out. A claim's text reaches the coach only in the plan's `explain` action, after the probes the rules require.
 */
export function findingsOutput(claims: AssessedClaim[]): Record<string, unknown> {
  return {
    covered: claims.filter((c) => c.verdict === 'covered').map((c) => ({ you_said: tagged('student_words', c.studentQuote) })),
    partly: claims.filter((c) => c.verdict === 'partial').map((c) => ({ you_said: tagged('student_words', c.studentQuote) })),
    incorrect: claims
      .filter((c) => c.verdict === 'incorrect')
      .map((c) => ({
        you_said: tagged('student_words', c.studentQuote),
        wrong_idea: tagged('student_words', c.misconception),
        // The page, not the claim: the claim's text comes only with action explain, after the probes (teach-back.ts).
        page: c.page,
      })),
    missing: claims.filter((c) => c.verdict === 'missing').map((c) => ({ pointer: c.pointer ?? null })),
  }
}

// ---------------------------------------------------------------------------------------------- teach it back

/** Concepts of the topic that have claims to explain against, weakest first (lowest mastery, then the order of the pages). */
async function weakestFirst(userId: string, concepts: RecallConcept[], now = new Date()): Promise<RecallConcept[]> {
  const ids = concepts.map((concept) => concept.id)
  const [kinds, memories] = await Promise.all([
    prisma.concept.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true } }),
    prisma.conceptMemory.findMany({ where: { userId, conceptId: { in: ids } } }),
  ])
  const kindOf = new Map(kinds.map((concept) => [concept.id, concept.kind as ConceptKind]))
  const memoryOf = new Map(memories.map((memory) => [memory.conceptId, memory]))
  const mastery = (id: string) => {
    const memory = memoryOf.get(id)
    return memory ? conceptMastery(stateFromMemoryRow(memory), kindOf.get(id) ?? 'concept', now).mastery : 0
  }
  return concepts
    .map((concept, position) => ({ concept, position, mastery: mastery(concept.id) }))
    .sort((a, b) => a.mastery - b.mastery || a.position - b.position)
    .map((entry) => entry.concept)
}

export async function getConceptToExplain(ctx: TeachToolContext, state: CoachState): Promise<TeachToolResult> {
  if (!ctx.topicId) return error(NO_TOPIC)
  const concepts = await loadRecallConcepts(ctx.topicId)
  if (concepts.length === 0) return error('This topic has no claims from the student\'s pages to check an explanation against.')
  const open = concepts.filter((concept) => !state.teach.concepts[concept.id]?.outcome)
  if (open.length === 0) {
    await endSession(ctx.sessionId)
    return { output: { done: true, message: 'Every idea has been worked through. Sum up and say goodbye.' }, events: [{ type: 'session_complete' }], sessionComplete: true }
  }
  // An idea already begun is the one to finish; otherwise the weakest.
  const begun = open.find((concept) => concept.id === state.teach.current)
  const concept = begun ?? (await weakestFirst(ctx.userId, open))[0]
  state.teach.current = concept.id
  state.teach.concepts[concept.id] ??= emptyConceptState()
  state.teach.askedTurn = ctx.turn
  await saveState(ctx.sessionId, state)
  const prompt = conceptTeachBackPrompt(concept.name)
  return {
    output: { done: false, concept_id: concept.id, concept_name: concept.name, prompt, ideas_left: open.length },
    events: [{ type: 'board', kind: 'concept', text: prompt, idea: { name: concept.name, conceptId: concept.id } }],
  }
}

async function scoreSayBack(ctx: TeachToolContext, concept: RecallConcept, claimId: string, said: string): Promise<void> {
  const claim = concept.claims.find((entry) => entry.id === claimId)
  if (!claim) return
  // A second grader call for the same answer: it counts against the per-user limit like the first. Over the limit there
  // is no grade, so nothing is written (as when the grader is unavailable), and the coach goes on.
  if (!(await ctx.allowGrading())) return
  let score = 0
  try {
    const graded = await grade(ctx, {
      prompt: conceptTeachBackPrompt(concept.name),
      claims: claimsForGrading([{ ...concept, claims: [claim] }]),
      answer: said,
      user_id: ctx.userId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId,
    })
    const found = graded.status === 'graded' ? graded.verdicts.find((entry) => entry.claim_id === claim.id) : undefined
    // An answer the grader could not read says nothing about the claim: a miss, not a score taken from something else.
    score = found ? verdictScore(found.verdict) : 0
  } catch (failure) {
    if (!isUnavailable(failure)) throw failure
    // The coach is told nothing is lost: without a grade there is nothing to write.
    return
  }
  await writeAssistedEvidence(ctx, {
    itemKey: `${itemKey({ kind: 'teach_back', topicId: ctx.topicId ?? '', conceptId: concept.id })}:say_back:${claim.id}`,
    conceptId: concept.id,
    source: 'teach_back',
    score,
    metadata: { mode: 'teach_back_say_back', claimId: claim.id },
  })
}

/** What the student has said about the idea, newest last, cut to what the grader takes. */
function saidTogether(said: string[]): string {
  let text = said.join(' ')
  while (text.length > MAX_RECALL_ANSWER_CHARS && said.length > 1) {
    said = said.slice(1)
    text = said.join(' ')
  }
  return text.slice(-MAX_RECALL_ANSWER_CHARS)
}

/**
 * The first explanation of an idea goes through the written teach-back's own function: the same grader, the same level
 * rules (level 0 the first time that day, source teach_back, model weight 0.7) and the same stored attempt. The answers
 * that follow the coach's probes are not scored again as explanations: they are assessed together with what the student
 * said before, so one probe answer is not judged against every claim on its own. The one answer that is scored is the
 * student saying an explanation back after two probes, which counts as level 2 on that claim.
 */
export async function assessExplanation(ctx: TeachToolContext, state: CoachState, args: { concept_id: string }): Promise<TeachToolResult> {
  if (!ctx.topicId) return error(NO_TOPIC)
  const concepts = await loadRecallConcepts(ctx.topicId)
  const concept = concepts.find((entry) => entry.id === args.concept_id)
  if (!concept) return error('Concept not found. Call get_concept_to_explain.')
  const before = state.teach.concepts[concept.id] ?? emptyConceptState()
  if (before.outcome) return error('That idea is finished. Call get_concept_to_explain for the next one.')
  // The explanation is what the student said since the last prompt or probe, as the server heard it.
  const explanation = heardSince(state, state.teach.askedTurn)
  if (!explanation) return error(NOBODY_SPOKE)
  // One test for "I don't know", typed or spoken (lib/learning/dont-know.ts). The first one is not graded: nothing was said.
  const dontKnow = isDontKnow(explanation)
  const first = before.assessments === 0
  const skipGrader = dontKnow && first
  if (!skipGrader && !(await ctx.allowGrading())) return error(TOO_FAST)

  const said = [...before.said, explanation]
  let verdicts: Pick<StoredClaim, 'claim_id' | 'verdict' | 'student_quote' | 'misconception' | 'pointer' | 'reasoning_gap'>[]
  try {
    if (skipGrader) {
      verdicts = concept.claims.map((claim) => ({ claim_id: claim.id, verdict: 'missing' as const, student_quote: null, misconception: null, pointer: null, reasoning_gap: null }))
      await writeIdkEvidence(ctx, concept.id)
    } else if (first) {
      const result = await submitRecall(
        {
          kind: 'teach_back',
          conceptId: concept.id,
          objectiveIndex: null,
          userId: ctx.userId,
          topicId: ctx.topicId,
          answer: explanation,
          abandoned: false,
          inputMode: 'voice',
          timeZone: ctx.timeZone,
        },
        ctx.grade ?? requestRecallGrade
      )
      if (result.status === 'not_found' || result.status === 'not_ready') return error('Concept not found. Call get_concept_to_explain.')
      if (result.status === 'invalid') return error('There was no explanation to assess. Ask the student again.')
      if (result.status === 'ungraded') return clarifyAfter(ctx, state, result.clarifyingQuestion)
      verdicts = result.claims
    } else {
      const graded = await grade(ctx, {
        prompt: conceptTeachBackPrompt(concept.name),
        claims: claimsForGrading([concept]),
        answer: saidTogether(said),
        user_id: ctx.userId,
        project_id: ctx.projectId,
        session_id: ctx.sessionId,
      })
      const sent = new Set(concept.claims.map((claim) => claim.id))
      verdicts = graded.verdicts.filter((verdict) => sent.has(verdict.claim_id)).map(toStored)
      if (graded.status !== 'graded' || verdicts.length === 0) return clarifyAfter(ctx, state, graded.clarifying_question)
    }
  } catch (failure) {
    if (isUnavailable(failure)) return error(UNAVAILABLE)
    throw failure
  }

  const claims = assessed(concept, verdicts)
  const coveredSomething = claims.some((claim) => claim.verdict === 'covered' || claim.verdict === 'partial')
  const prerequisite = coveredSomething ? null : await weakPrerequisite(ctx.userId, concept.id)
  // The band is read after this explanation's own evidence is written, so a student who has just shown they do not know it gets support.
  const band = await lowestBand(ctx.userId, [concept.id])
  const next = assessmentResult(concept.name, claims, { ...before, said: said.slice(-12) }, prerequisite, { dontKnow, band })
  state.teach.current = concept.id
  state.teach.concepts[concept.id] = next.state
  state.teach.askedTurn = ctx.turn
  await saveState(ctx.sessionId, state)

  // The say-back: the student's own words for the one claim the coach explained, after two probes. It is judged on what was
  // said just now and against that claim alone, so a wrong sentence from earlier cannot count against it. Level 2.
  if (before.sayBack) await scoreSayBack(ctx, concept, before.sayBack, explanation)
  // Every explain step is instruction: it is the explanation the student did not have (lastInstructionAt, spec 18.5).
  if ((next.plan.action === 'explain' || next.plan.action === 'explain_first') && ctx.topicId) {
    await recordInstruction(prisma, {
      userId: ctx.userId,
      topicId: ctx.topicId,
      kind: 'voice_explain',
      conceptIds: [concept.id],
      ref: `${concept.id}:${next.plan.gap.claimId}`,
      timeZone: ctx.timeZone,
    }).catch((failure) => console.error('Recording the voice explanation failed:', failure))
  }

  return { output: next.output, events: await ideaDone(concept, next.output, next.state) }
}

/**
 * The browser is told when an idea closes, for the summary: explained, or taught after probes with the pages to look at
 * again (and a link to each page in the student's own file).
 */
async function ideaDone(concept: { id: string; name: string }, output: Record<string, unknown>, state: ConceptState): Promise<VoiceEvent[]> {
  if (output.action !== 'wrap_up' || (output.outcome !== 'explained' && output.outcome !== 'taught')) return []
  const said = Array.isArray(output.look_again) ? output.look_again.filter((page): page is string => typeof page === 'string') : []
  const explainedIds = Object.keys(state.gaps).filter((claimId) => state.gaps[claimId].explained)
  // The pages come from the explained claims' own page data; the coach's "p. N" text is only a fallback for a claim that cannot be found.
  let lookLinks: PageLink[] = []
  if (said.length > 0 && explainedIds.length > 0) {
    const rows = await prisma.conceptClaim.findMany({
      where: { id: { in: explainedIds }, conceptId: concept.id },
      orderBy: { orderIndex: 'asc' },
      select: { pageStart: true, pageEnd: true, materialId: true, material: { select: { filename: true } } },
    })
    lookLinks = pageLinksOf(rows)
  }
  const lookAgain = lookLinks.length > 0 ? lookLinks.map((link) => link.label) : said
  return [
    {
      type: 'idea_done',
      name: concept.name,
      outcome: output.outcome,
      conceptId: concept.id,
      ...(lookAgain.length > 0 ? { lookAgain } : {}),
      ...(lookLinks.length > 0 ? { lookLinks } : {}),
    },
  ]
}

/**
 * What an assessment of an explanation leads to: the coach's next step and the state after it. Pure, so the tutoring eval's
 * Python mirror (evals/tutoring/teach_state.py) is pinned to it by a fixture.
 */
export function assessmentResult(
  conceptName: string,
  claims: AssessedClaim[],
  before: ConceptState,
  prerequisite: string | null,
  options: { dontKnow?: boolean; band?: Band } = {}
): { output: Record<string, unknown>; state: ConceptState; plan: Plan } {
  const next = planNext(claims, before, { weakPrerequisite: prerequisite, dontKnow: options.dontKnow, band: options.band })
  const lookAgain = Object.keys(next.state.gaps)
    .filter((claimId) => next.state.gaps[claimId].explained)
    .flatMap((claimId) => {
      const page = claims.find((claim) => claim.claimId === claimId)?.page
      return page ? [`p. ${page}`] : []
    })
  return {
    plan: next.plan,
    state: next.state,
    output: {
      concept: conceptName,
      ...findingsOutput(claims),
      ...planOutput(next.plan, claims, prerequisite),
      ...(next.plan.action === 'wrap_up' ? { outcome: next.state.outcome, ...(lookAgain.length > 0 ? { look_again: lookAgain } : {}) } : {}),
    },
  }
}

/** What the answer to the new example leads to. Pure, for the same reason. */
export function exampleResult(conceptName: string, claims: AssessedClaim[], before: ConceptState): { output: Record<string, unknown>; state: ConceptState; passed: boolean } {
  const passed = exampleHeld(claims)
  const next = afterExample(claims, before, passed)
  return {
    passed,
    state: next.state,
    output: {
      concept: conceptName,
      passed,
      ...findingsOutput(claims),
      ...planOutput(next.plan, claims, null),
      ...(next.plan.action === 'wrap_up' ? { outcome: next.state.outcome } : {}),
    },
  }
}

const toStored = (verdict: RecallGradeAnswer['verdicts'][number]) => ({
  claim_id: verdict.claim_id,
  verdict: verdict.verdict,
  student_quote: verdict.student_quote ?? null,
  misconception: verdict.misconception ?? null,
  pointer: verdict.pointer ?? null,
  reasoning_gap: typeof verdict.reasoning_gap === 'boolean' ? verdict.reasoning_gap : null,
})

/** A clarifying question: the words just heard are used up (asking again needs new ones), nothing else is stored. */
async function clarifyAfter(ctx: TeachToolContext, state: CoachState, question: string | null | undefined): Promise<TeachToolResult> {
  state.teach.askedTurn = ctx.turn
  await saveState(ctx.sessionId, state)
  return clarify(question)
}

function clarify(question: string | null | undefined): TeachToolResult {
  // Nothing was stored and no probe was spent: the student says it again.
  return {
    output: {
      action: 'clarify',
      clarifying_question: question || 'Can you say a little more about how it works?',
      instruction: 'The answer was too short or unclear to assess. Ask the clarifying question in your own words.',
    },
    events: [],
  }
}

/** A spoken "I don't know" on a check right after the claim was told: level 2, score 0, no confidence. A failed write is logged. */
async function writeIdkAssisted(ctx: TeachToolContext, input: { itemKey: string; conceptId: string; metadata: Record<string, unknown> }): Promise<void> {
  if (!ctx.topicId) return
  try {
    await recordEvidence(
      dontKnowEvidence({
        userId: ctx.userId,
        projectId: ctx.projectId,
        topicId: ctx.topicId,
        itemKey: input.itemKey,
        conceptIds: [input.conceptId],
        sessionKey: `voice:${ctx.sessionId}`,
        surface: 'voice',
        level: 2,
        metadata: input.metadata,
      }),
      { timeZone: ctx.timeZone, userId: ctx.userId, skipIfPresent: true }
    )
  } catch (failure) {
    console.error('Recording voice evidence failed:', failure)
  }
}

/** A spoken "I don't know" on the first explanation: level 1, score 0, no confidence, recorded once per concept and day. A failed write is logged. */
async function writeIdkEvidence(ctx: TeachToolContext, conceptId: string): Promise<void> {
  if (!ctx.topicId) return
  try {
    await recordEvidence(
      dontKnowEvidence({
        userId: ctx.userId,
        projectId: ctx.projectId,
        topicId: ctx.topicId,
        itemKey: `${itemKey({ kind: 'teach_back', topicId: ctx.topicId, conceptId })}:idk`,
        conceptIds: [conceptId],
        sessionKey: `voice:${ctx.sessionId}`,
        surface: 'teach_back',
        level: 1,
        metadata: { mode: 'teach_back_idk' },
      }),
      { timeZone: ctx.timeZone, userId: ctx.userId, skipIfPresent: true }
    )
  } catch (failure) {
    console.error('Recording voice evidence failed:', failure)
  }
}

/**
 * One answer given right after the material was just discussed or taught, written as evidence: level 2 when it holds, a
 * level-1 miss with no score when it does not (the recall rules, `recallLevel`). A failed write is logged and never
 * takes the answer away.
 */
async function writeAssistedEvidence(
  ctx: TeachToolContext,
  input: { itemKey: string; conceptId: string; source: 'teach_back' | 'voice'; score: number; metadata: Record<string, unknown> }
): Promise<void> {
  try {
    const level = recallLevel({ abandoned: false, repeat: 'seen' }, input.score)
    await recordEvidence(
      [
        {
          userId: ctx.userId,
          projectId: ctx.projectId,
          topicId: ctx.topicId,
          itemKey: input.itemKey,
          conceptIds: [input.conceptId],
          source: input.source,
          score: level.score,
          assistance: level.assistance,
          gradedBy: 'model',
          sessionKey: `voice:${ctx.sessionId}`,
          metadata: input.metadata,
        },
      ],
      { timeZone: ctx.timeZone, userId: ctx.userId, skipIfPresent: true }
    )
  } catch (failure) {
    console.error('Recording voice evidence failed:', failure)
  }
}


/** The check after a full-coverage explanation: one new example or prediction, answered and graded against the concept's claims. */
async function recordExampleCheck(
  ctx: TeachToolContext,
  state: CoachState,
  args: { concept_id: string; question: string }
): Promise<TeachToolResult> {
  if (!ctx.topicId) return error(NO_TOPIC)
  const concepts = await loadRecallConcepts(ctx.topicId)
  const concept = concepts.find((entry) => entry.id === args.concept_id)
  const before = state.teach.concepts[args.concept_id]
  if (!concept || !before) return error('Concept not found. Call get_concept_to_explain.')
  if (before.outcome) return error('That idea is finished. Call get_concept_to_explain for the next one.')
  if (!before.exampleAsked) return error('The new example is asked after assess_explanation says ask_new_example.')
  const answer = heardSince(state, state.teach.askedTurn)
  if (!answer) return error(NOBODY_SPOKE)
  if (!(await ctx.allowGrading())) return error(TOO_FAST)

  let graded: RecallGradeAnswer
  try {
    graded = await grade(ctx, {
      prompt: args.question,
      claims: claimsForGrading([concept]),
      answer,
      user_id: ctx.userId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId,
    })
  } catch (failure) {
    if (isUnavailable(failure)) return error(UNAVAILABLE)
    throw failure
  }
  const sent = new Set(concept.claims.map((claim) => claim.id))
  const verdicts = graded.verdicts.filter((verdict) => sent.has(verdict.claim_id))
  if (graded.status !== 'graded' || verdicts.length === 0) {
    state.teach.askedTurn = ctx.turn
    await saveState(ctx.sessionId, state)
    return {
      output: {
        action: 'clarify',
        clarifying_question: graded.clarifying_question || 'Can you say a little more about how it works in that case?',
        instruction: 'The answer was too short or unclear to assess. Ask the clarifying question in your own words.',
      },
      events: [],
    }
  }
  const claims = assessed(concept, verdicts.map(toStored))
  const next = exampleResult(concept.name, claims, before)
  const passed = next.passed
  state.teach.concepts[concept.id] = next.state
  state.teach.askedTurn = ctx.turn
  await saveState(ctx.sessionId, state)

  await writeAssistedEvidence(ctx, {
    itemKey: `voice:${ctx.sessionId}:check:${concept.id}`,
    conceptId: concept.id,
    source: 'voice',
    score: passed ? 1 : 0,
    metadata: { mode: 'teach_back_check' },
  })

  return { output: next.output, events: await ideaDone(concept, next.output, next.state) }
}

// ---------------------------------------------------------------------------------------------- guided reading

type ReadingClaim = {
  id: string
  conceptId: string
  conceptName: string
  text: string
  quote: string
  page: number | null
  source: { label: string; href: string } | null
}

/** Every claim of the topic's active concepts, in the order of the concepts and then of the claims. */
export async function loadReadingClaims(topicId: string): Promise<ReadingClaim[]> {
  const rows = await prisma.concept.findMany({
    where: { topicId, status: 'active' },
    orderBy: { orderIndex: 'asc' },
    select: {
      id: true,
      name: true,
      claims: {
        orderBy: { orderIndex: 'asc' },
        select: { id: true, text: true, quote: true, pageStart: true, pageEnd: true, materialId: true, material: { select: { filename: true } } },
      },
    },
  })
  return rows.flatMap((concept) =>
    concept.claims.map((claim) => ({
      id: claim.id,
      conceptId: concept.id,
      conceptName: concept.name,
      text: claim.text,
      quote: claim.quote,
      page: claim.pageStart,
      source: {
        label: claim.pageStart ? pageLabel(claim.pageStart, claim.pageEnd) : claim.material.filename,
        href: viewerUrl({ materialId: claim.materialId, filename: claim.material.filename, pageStart: claim.pageStart }),
      },
    }))
  )
}

/** The check after a claim told before the coach has chosen one: the student says it back in their own words. */
export function defaultCheckQuestion(conceptName: string): string {
  return `In your own words, what do your pages say about "${conceptName}"?`
}

export function predictionPrompt(conceptName: string): string {
  return `What do you expect your pages say about "${conceptName}"?`
}

export async function nextClaim(
  ctx: TeachToolContext,
  state: CoachState,
  args: { reveal?: boolean; check_question?: string }
): Promise<TeachToolResult> {
  if (!ctx.topicId) return error(NO_TOPIC)
  const claims = await loadReadingClaims(ctx.topicId)
  if (claims.length === 0) return error("This topic has no claims from the student's pages to read.")
  const guided = state.guided

  if (args.reveal) {
    const claim = claims[guided.index]
    if (!claim || guided.stage !== 'predicting') {
      return error('Ask the student for a prediction first: call next_claim with no arguments, ask the prediction, and wait for the answer.')
    }
    // The prediction is what the student said after the prompt, as the server heard it: the claim is not shown before they speak.
    const prediction = heardSince(state, guided.askedTurn).trim()
    // Run before the model has spoken (spec 19.1), the reveal has no question from the coach: the server's own is asked.
    const checkQuestion = (args.check_question ?? '').trim() || (ctx.autoCheck ? defaultCheckQuestion(claim.conceptName) : '')
    if (!prediction) return error(NOBODY_SPOKE)
    if (!checkQuestion) return error('Pass check_question: the question you will ask after telling the student the claim.')
    guided.stage = 'taught'
    guided.prediction = prediction.slice(0, 1000)
    guided.checkQuestion = checkQuestion.slice(0, 500)
    guided.askedTurn = ctx.turn
    await saveState(ctx.sessionId, state)
    return {
      output: {
        done: false,
        claim_index: guided.index,
        of: claims.length,
        concept_name: claim.conceptName,
        claim: { text: tagged('source_claim', claim.text), page: claim.page },
        instruction: ctx.autoCheck
          ? `State the claim in one to three sentences with its page, say how it matched the prediction, then ask the check question and wait. The check question is "${guided.checkQuestion}": reword it if you like and keep its meaning.`
          : 'State the claim in one to three sentences with its page, say how it matched the prediction, then ask your check question and wait.',
      },
      events: [{ type: 'board', kind: 'claim', text: claim.text, question: guided.checkQuestion, ...(claim.source ? { source: claim.source } : {}) }],
    }
  }

  // A claim that was told but not checked is left behind when the student asks to move on.
  if (guided.stage === 'taught') guided.index += 1
  if (guided.index >= claims.length) {
    guided.stage = 'idle'
    await saveState(ctx.sessionId, state)
    await endSession(ctx.sessionId)
    return { output: { done: true, message: 'Every claim has been read. Sum up and say goodbye.' }, events: [{ type: 'session_complete' }], sessionComplete: true }
  }
  const claim = claims[guided.index]
  guided.stage = 'predicting'
  guided.prediction = ''
  guided.checkQuestion = ''
  guided.askedTurn = ctx.turn
  await saveState(ctx.sessionId, state)
  const prompt = predictionPrompt(claim.conceptName)
  return {
    output: {
      done: false,
      claim_index: guided.index,
      of: claims.length,
      concept_name: claim.conceptName,
      prediction_prompt: prompt,
      instruction: 'Ask the student to predict what their pages say about this idea. Do not state the claim yet.',
    },
    events: [{ type: 'board', kind: 'prediction', text: prompt }],
  }
}

async function recordReadingCheck(ctx: TeachToolContext, state: CoachState, args: { claim_index: number; idk?: boolean }): Promise<TeachToolResult> {
  if (!ctx.topicId) return error(NO_TOPIC)
  const claims = await loadReadingClaims(ctx.topicId)
  const guided = state.guided
  const claim = claims[args.claim_index]
  if (!claim) return error('Claim not found.')
  if (guided.stage !== 'taught' || guided.index !== args.claim_index) {
    return error('That claim has not been told yet, or was already checked. Call next_claim.')
  }
  // The answer is what the student said after the check question was asked (the claim was told in the turn before).
  const answer = heardSince(state, guided.askedTurn)
  if (!answer) return error(NOBODY_SPOKE)

  // "I don't know" (the coach's flag, or what was heard): nothing to grade. Missed at level 2, as the claim was just told,
  // and the claim is restated before the reading moves on (spec 5.8, 18.3).
  if (args.idk === true || isDontKnow(answer)) {
    guided.stage = 'idle'
    guided.index += 1
    guided.prediction = ''
    guided.checkQuestion = ''
    guided.askedTurn = ctx.turn
    await saveState(ctx.sessionId, state)
    await writeIdkAssisted(ctx, {
      itemKey: itemKey({ kind: 'voice', sessionId: ctx.sessionId, index: args.claim_index }),
      conceptId: claim.conceptId,
      metadata: { mode: 'guided_reading', claimId: claim.id },
    })
    return {
      output: {
        verdict: 'not yet',
        claim: { text: tagged('source_claim', claim.text), page: claim.page },
        claims_left: claims.length - guided.index,
        instruction: 'The student did not know. Restate the claim in one sentence from source_claim, with its page, then call next_claim.',
      },
      events: [{ type: 'evaluation', isCorrect: false, score: 0, comment: '', explanation: '' }],
    }
  }
  if (!(await ctx.allowGrading())) return error(TOO_FAST)

  let graded: RecallGradeAnswer
  try {
    graded = await grade(ctx, {
      prompt: guided.checkQuestion,
      claims: [{ id: claim.id, concept_id: claim.conceptId, concept_name: claim.conceptName, text: claim.text, quote: claim.quote.slice(0, 300), ...(claim.page !== null ? { page: claim.page } : {}) }],
      answer,
      user_id: ctx.userId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId,
    })
  } catch (failure) {
    if (isUnavailable(failure)) return error(UNAVAILABLE)
    throw failure
  }
  const verdict = graded.verdicts.find((entry) => entry.claim_id === claim.id)
  if (graded.status !== 'graded' || !verdict) {
    // Nothing is scored and the claim stays open: the student answers again, in words of their own after this turn.
    guided.askedTurn = ctx.turn
    await saveState(ctx.sessionId, state)
    return {
      output: { action: 'clarify', clarifying_question: graded.clarifying_question || 'Can you say a little more about that?', instruction: 'The answer was too short or unclear to assess. Ask the clarifying question in your own words.' },
      events: [],
    }
  }

  const score = verdictScore(verdict.verdict)
  guided.stage = 'idle'
  guided.index += 1
  guided.prediction = ''
  guided.checkQuestion = ''
  guided.askedTurn = ctx.turn
  await saveState(ctx.sessionId, state)

  await writeAssistedEvidence(ctx, {
    itemKey: itemKey({ kind: 'voice', sessionId: ctx.sessionId, index: args.claim_index }),
    conceptId: claim.conceptId,
    source: 'voice',
    score,
    metadata: { mode: 'guided_reading', claimId: claim.id },
  })

  const right = verdict.verdict === 'covered'
  const label = right ? 'right' : verdict.verdict === 'partial' ? 'partly right' : verdict.verdict === 'incorrect' ? 'not right' : 'not yet'
  return {
    output: {
      verdict: label,
      ...(verdict.student_quote ? { you_said: tagged('student_words', verdict.student_quote) } : {}),
      ...(verdict.misconception ? { wrong_idea: tagged('student_words', verdict.misconception) } : {}),
      claim: { text: tagged('source_claim', claim.text), page: claim.page },
      claims_left: claims.length - guided.index,
      instruction: 'Say in a sentence what was right and the one thing to fix, then call next_claim.',
    },
    events: [
      {
        type: 'evaluation',
        isCorrect: right,
        score,
        comment: '',
        explanation: '',
      },
    ],
  }
}

// ---------------------------------------------------------------------------------------------- the entry point

/** record_check means the new example in teach-back and the claim's check in guided reading. */
export async function recordCheck(ctx: TeachToolContext, state: CoachState, style: 'teach_back' | 'guided_reading', args: Record<string, unknown>): Promise<TeachToolResult> {
  if (style === 'guided_reading') {
    const claimIndex = args.claim_index
    if (typeof claimIndex !== 'number' || !Number.isInteger(claimIndex) || claimIndex < 0) return error('Invalid arguments for record_check')
    return recordReadingCheck(ctx, state, { claim_index: claimIndex, idk: args.idk === true })
  }
  const conceptId = typeof args.concept_id === 'string' ? args.concept_id : ''
  const question = typeof args.question === 'string' ? args.question.trim() : ''
  if (!conceptId || !question) return error('Invalid arguments for record_check')
  return recordExampleCheck(ctx, state, { concept_id: conceptId, question: question.slice(0, 1000) })
}
