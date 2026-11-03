/**
 * Recall and teach-back (spec §5.3). Server only.
 *
 * - A recall card is one objective's prompt (stored with the topic's concepts as `recall_prompts`), or the
 *   whole topic. A teach-back is "Explain it" for one concept, or for the whole topic. Each is graded against
 *   the claims of the concepts it covers and nothing else.
 * - The AI service answers with a verdict per claim, or with one clarifying question when the answer is too
 *   short or unclear to grade. A clarifying question stores nothing: the student writes again.
 * - A graded answer is stored as a RecallAttempt, becomes one score per concept (recall-scores.ts) and is
 *   written as level-0 evidence, or level 2 when the reader or explainer was opened while the card was open.
 *   The first level-0 graded recall sets `TopicProgress.recallAt` (once, atomically).
 * - The server decides the level from the stored attempts: the reading opened while the card was open, or a second
 *   try the same local day after feedback on the same ideas, is assisted; a later day is a new level-0 retrieval.
 *   "The same ideas" is read from the claims the earlier attempts were graded on, not from the card: the feedback
 *   named the ideas, so another card (the whole topic, a teach-back) that covers one of them is a second try too.
 * - "I don't remember" (the button, or a typed admission that `isDontKnow` reads) skips the grader: it is a failed first try
 *   at level 1 on every concept of the card (spec 18.3), stored as an attempt whose claims are all missing, with
 *   `result.idk`. It sets `recallAt` once, like a graded recall, so the way on (the pointers and the explainer) opens.
 * - The feedback quotes the student first, then shows what is wrong with the source's own words and page, and
 *   points at what was missed without saying it. "Show me what I missed" reveals those claims and records
 *   level 3 on their concepts.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { requestRecallGrade, type RecallClaimVerdict, type RecallGradeAnswer, type RecallGradeRequest } from '@/lib/ai-service/recall'
import { recordEvidence } from './evidence'
import { itemKey } from './item-key'
import { recallEvidence, recallIdkEvidence, revealEvidence } from './recall-evidence'
import { isDontKnow } from './dont-know'
import { helpAfterMiss } from './instruction-server'
import type { MissKind } from '@/lib/tutor/state'
import { localDay } from './plan'
import { conceptRecallScores, type ClaimVerdictKind } from './recall-scores'
import { MAX_RECALL_ANSWER_CHARS, type RecallCard, type RecallFeedback, type RecallState, type RevealedClaim } from './recall-shared'

export { MAX_RECALL_ANSWER_CHARS }
export type { RecallCard, RecallFeedback, RecallState, RevealedClaim }

export const WHOLE_TOPIC_PROMPT = 'Explain this topic in your own words: its main ideas and how they fit together.'
export const WHOLE_TOPIC_TEACH_BACK_PROMPT = 'Teach this topic to a classmate who has not read it. What are its main ideas, and how do they fit together?'
export const conceptTeachBackPrompt = (name: string) => `Explain "${name}" in your own words, as if you were teaching it to a classmate.`

const MAX_CLAIMS = 40
const MAX_QUOTE_CHARS = 300
const VERDICTS: ClaimVerdictKind[] = ['covered', 'partial', 'missing', 'incorrect']
const MISS_KINDS: MissKind[] = ['cue_miss', 'discrimination', 'execution', 'careless', 'misconception']

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

// ------------------------------------------------------------------------------------------ what a card covers

export type RecallConcept = {
  id: string
  name: string
  objectiveIndexes: number[]
  claims: { id: string; text: string; quote: string; page: number | null }[]
}

export type RecallTarget = {
  kind: 'recall' | 'teach_back'
  /** The objective the card is for; null for the whole topic and for a teach-back. */
  objectiveIndex: number | null
  /** The one concept a teach-back is for; null otherwise. */
  conceptId: string | null
  prompt: string
  concepts: RecallConcept[]
  itemKey: string
}

export type TargetRequest = { kind: 'recall' | 'teach_back'; objectiveIndex?: number | null; conceptId?: string | null }

/** The objectives' prompts as stored with the topic's concepts. */
export async function loadRecallPrompts(topicId: string): Promise<Map<number, string>> {
  const row = await prisma.topicContent.findUnique({ where: { topicId_contentType: { topicId, contentType: 'concept_prompts' } }, select: { contentData: true } })
  const list: unknown[] = isRecord(row?.contentData) && Array.isArray(row.contentData.recall_prompts) ? row.contentData.recall_prompts : []
  const prompts = new Map<number, string>()
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.objective_index !== 'number' || typeof entry.prompt !== 'string' || !entry.prompt.trim()) continue
    if (!prompts.has(entry.objective_index)) prompts.set(entry.objective_index, entry.prompt.trim())
  }
  return prompts
}

/** The topic's active concepts that have claims to grade against, in order. A concept with no claims cannot be recalled. */
export async function loadRecallConcepts(topicId: string): Promise<RecallConcept[]> {
  const rows = await prisma.concept.findMany({
    where: { topicId, status: 'active' },
    orderBy: { orderIndex: 'asc' },
    select: {
      id: true,
      name: true,
      objectiveIndexes: true,
      claims: { orderBy: { orderIndex: 'asc' }, select: { id: true, text: true, quote: true, pageStart: true } },
    },
  })
  return rows
    .filter((row) => row.claims.length > 0)
    .map((row) => ({
      id: row.id,
      name: row.name,
      objectiveIndexes: row.objectiveIndexes,
      claims: row.claims.map((claim) => ({ id: claim.id, text: claim.text, quote: claim.quote, page: claim.pageStart })),
    }))
}

/** What a request is about: its prompt, the concepts whose claims grade it and its item key. Null when it covers nothing. */
export function resolveTarget(concepts: RecallConcept[], prompts: Map<number, string>, request: TargetRequest): RecallTarget | null {
  if (request.kind === 'teach_back') {
    if (request.conceptId) {
      const concept = concepts.find((c) => c.id === request.conceptId)
      if (!concept) return null
      return { kind: 'teach_back', objectiveIndex: null, conceptId: concept.id, prompt: conceptTeachBackPrompt(concept.name), concepts: [concept], itemKey: '' }
    }
    return concepts.length > 0 ? { kind: 'teach_back', objectiveIndex: null, conceptId: null, prompt: WHOLE_TOPIC_TEACH_BACK_PROMPT, concepts, itemKey: '' } : null
  }
  if (request.objectiveIndex !== undefined && request.objectiveIndex !== null) {
    const prompt = prompts.get(request.objectiveIndex)
    const covered = concepts.filter((c) => c.objectiveIndexes.includes(request.objectiveIndex as number))
    if (!prompt || covered.length === 0) return null
    return { kind: 'recall', objectiveIndex: request.objectiveIndex, conceptId: null, prompt, concepts: covered, itemKey: '' }
  }
  return concepts.length > 0 ? { kind: 'recall', objectiveIndex: null, conceptId: null, prompt: WHOLE_TOPIC_PROMPT, concepts, itemKey: '' } : null
}

function withItemKey(topicId: string, target: RecallTarget): RecallTarget {
  const key =
    target.kind === 'teach_back'
      ? itemKey({ kind: 'teach_back', topicId, conceptId: target.conceptId ?? 'all' })
      : itemKey({ kind: 'recall', topicId, objective: target.objectiveIndex ?? 'all' })
  return { ...target, itemKey: key }
}

/** The key a card is known by in the browser and among a topic's attempts: `o2`, `all`, `tb:<conceptId>` or `tb`. */
export const cardKey = (target: Pick<RecallTarget, 'kind' | 'objectiveIndex' | 'conceptId'>): string =>
  target.kind === 'teach_back' ? (target.conceptId ? `tb:${target.conceptId}` : 'tb') : target.objectiveIndex === null ? 'all' : `o${target.objectiveIndex}`

// ------------------------------------------------------------------------------------------ feedback

export type StoredClaim = {
  claim_id: string
  concept_id: string
  verdict: ClaimVerdictKind
  student_quote: string | null
  misconception: string | null
  kind: MissKind | null
  pointer: string | null
  /** True or false for a covered claim the grader judged; null when it did not say. */
  reasoning_gap: boolean | null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

function readStoredClaims(result: unknown): StoredClaim[] {
  if (!isRecord(result) || !Array.isArray(result.claims)) return []
  return result.claims.filter(isRecord).flatMap((claim) => {
    const verdict = VERDICTS.find((v) => v === claim.verdict)
    const claimId = text(claim.claim_id)
    if (!verdict || !claimId) return []
    return [{ claim_id: claimId, concept_id: text(claim.concept_id) ?? '', verdict, student_quote: text(claim.student_quote), misconception: text(claim.misconception), kind: MISS_KINDS.find((k) => k === claim.kind) ?? null, pointer: text(claim.pointer), reasoning_gap: typeof claim.reasoning_gap === 'boolean' ? claim.reasoning_gap : null }]
  })
}

type ClaimLookup = Map<string, { claim: RecallConcept['claims'][number]; conceptName: string }>

const claimLookup = (concepts: RecallConcept[]): ClaimLookup =>
  new Map(concepts.flatMap((concept) => concept.claims.map((claim) => [claim.id, { claim, conceptName: concept.name }] as const)))

/** Claims the student asked to see: everything not covered. */
function revealedClaims(stored: StoredClaim[], lookup: ClaimLookup): RevealedClaim[] {
  return stored.flatMap((entry) => {
    const found = lookup.get(entry.claim_id)
    if (!found || entry.verdict === 'covered') return []
    return [{ claimId: entry.claim_id, conceptName: found.conceptName, text: found.claim.text, quote: found.claim.quote, page: found.claim.page }]
  })
}

export function buildFeedback(attemptId: string, result: unknown, lookup: ClaimLookup): RecallFeedback {
  const stored = readStoredClaims(result)
  const feedback: RecallFeedback = {
    attemptId,
    abandoned: isRecord(result) && result.abandoned === true,
    repeat: isRecord(result) && (result.repeat === 'seen' || result.repeat === 'revealed') ? result.repeat : null,
    idk: isRecord(result) && result.idk === true,
    got: [],
    wrong: [],
    missed: [],
    revealed: null,
    help: null,
  }
  for (const entry of stored) {
    const found = lookup.get(entry.claim_id)
    if (!found) continue
    const conceptName = found.conceptName
    if ((entry.verdict === 'covered' || entry.verdict === 'partial') && entry.student_quote) {
      feedback.got.push({ conceptName, quote: entry.student_quote, partial: entry.verdict === 'partial' })
    }
    if (entry.verdict === 'incorrect') {
      feedback.wrong.push({
        conceptName,
        studentQuote: entry.student_quote ?? '',
        misconception: entry.misconception ?? '',
        sourceQuote: found.claim.quote,
        page: found.claim.page,
      })
    }
    if (entry.verdict === 'missing' || entry.verdict === 'partial') {
      feedback.missed.push({ claimId: entry.claim_id, conceptName, pointer: entry.pointer ?? `Look again at ${conceptName}` })
    }
  }
  if (isRecord(result) && typeof result.revealedAt === 'string') feedback.revealed = revealedClaims(stored, lookup)
  return feedback
}

/** The concepts an attempt left a gap on: a claim missing, partial or incorrect. */
const missedConceptIds = (result: unknown): string[] => [...new Set(readStoredClaims(result).filter((claim) => claim.verdict !== 'covered').map((claim) => claim.concept_id).filter(Boolean))]

/** The feedback with where to look (spec 18.3), for an answer that left a gap; a clean one has none. */
async function withHelp(userId: string, topicId: string, feedback: RecallFeedback, result: unknown): Promise<RecallFeedback> {
  const conceptIds = missedConceptIds(result)
  if (conceptIds.length === 0) return feedback
  return { ...feedback, help: await helpAfterMiss(prisma, { userId, topicId, conceptIds, surface: 'recall' }) }
}

// ------------------------------------------------------------------------------------------ the state of the recall step

/** The cards of the recall step. A topic with no concept that has claims has none. */
export async function loadRecallState(userId: string, topicId: string, options: { mode?: 'recall' | 'teach_back'; conceptId?: string | null } = {}): Promise<RecallState | null> {
  const topic = await prisma.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { id: true } })
  if (!topic) return null
  const mode = options.mode ?? 'recall'
  const [concepts, prompts] = await Promise.all([loadRecallConcepts(topicId), loadRecallPrompts(topicId)])
  const requests: TargetRequest[] =
    mode === 'teach_back'
      ? [{ kind: 'teach_back', conceptId: options.conceptId ?? null }]
      : [...[...prompts.keys()].sort((a, b) => a - b).map((objectiveIndex) => ({ kind: 'recall' as const, objectiveIndex })), { kind: 'recall' as const }]
  const targets = requests.flatMap((request) => {
    const target = resolveTarget(concepts, prompts, request)
    return target ? [target] : []
  })
  if (targets.length === 0) return { mode, cards: [] }

  // The newest attempt of each card (a recall's card is its objective; a teach-back's concept is in the result).
  const attempts = await prisma.recallAttempt.findMany({
    where: { userId, topicId, kind: mode },
    orderBy: { createdAt: 'desc' },
    // A teach-back's concept is in its result, so its newest 200 are searched.
    distinct: mode === 'recall' ? ['objectiveIndex'] : [],
    take: mode === 'recall' ? undefined : 200,
    select: { id: true, objectiveIndex: true, result: true },
  })
  const lookup = claimLookup(concepts)
  const cards: RecallCard[] = await Promise.all(targets.map(async (target) => {
    const attempt = attempts.find((a) => {
      if (target.kind === 'teach_back') return (isRecord(a.result) ? text(a.result.conceptId) : null) === target.conceptId
      return a.objectiveIndex === target.objectiveIndex
    })
    return {
      key: cardKey(target),
      kind: target.kind,
      objectiveIndex: target.objectiveIndex,
      conceptId: target.conceptId,
      prompt: target.prompt,
      latest: attempt ? await withHelp(userId, topicId, buildFeedback(attempt.id, attempt.result, lookup), attempt.result) : null,
    }
  }))
  return { mode, cards }
}

// ------------------------------------------------------------------------------------------ submitting an answer

export type SubmitInput = TargetRequest & {
  userId: string
  topicId: string
  answer: string
  /** "I don't remember": the button. A typed admission is read from the answer. */
  idk?: boolean
  /** The reader or explainer was opened while the card was open. */
  abandoned: boolean
  inputMode: 'text' | 'voice'
  timeZone: string
}

export type SubmitResult =
  | { status: 'graded'; feedback: RecallFeedback; /** The verdict on each claim sent, as stored. */ claims: StoredClaim[]; repeat: 'seen' | 'revealed' | null }
  | { status: 'ungraded'; clarifyingQuestion: string }
  | { status: 'not_found' }
  | { status: 'not_ready' }
  | { status: 'invalid'; message: string }

const DEFAULT_QUESTION = 'Can you say more about what you remember, in a sentence or two?'

/** The claims of these concepts as the grader takes them (at most MAX_CLAIMS, quotes cut). Also used by the voice checks. */
export function claimsForGrading(concepts: RecallConcept[]): RecallGradeRequest['claims'] {
  return concepts
    .flatMap((concept) => concept.claims.map((claim) => ({ concept, claim })))
    .slice(0, MAX_CLAIMS)
    .map(({ concept, claim }) => ({
      id: claim.id,
      concept_id: concept.id,
      concept_name: concept.name,
      text: claim.text,
      quote: claim.quote.slice(0, MAX_QUOTE_CHARS),
      ...(claim.page !== null ? { page: claim.page } : {}),
    }))
}

function gradeRequest(input: SubmitInput, target: RecallTarget, projectId: string): RecallGradeRequest {
  return { prompt: target.prompt, claims: claimsForGrading(target.concepts), answer: input.answer, user_id: input.userId, project_id: projectId, session_id: input.topicId }
}

/** The concepts an attempt was graded on, and shown feedback about: its claims' concepts, and a teach-back's own. */
function gradedConceptIds(result: unknown): Set<string> {
  const ids = new Set(readStoredClaims(result).map((claim) => claim.concept_id).filter(Boolean))
  const own = isRecord(result) ? text(result.conceptId) : null
  if (own) ids.add(own)
  return ids
}

/**
 * Whether this answer is a second try. An answer on the same local day as an earlier graded one that covered any of
 * the same concepts has been through that attempt's feedback: assisted (`seen`), or `revealed` when the student asked
 * to see what they missed. The earlier attempt may be of any card or kind (the feedback named the ideas, whichever
 * card it came from), so answering the whole topic after one objective, or a teach-back after a recall, is not a fresh
 * look at what was shown. A later day is a new retrieval. A day apart is read in the student's zone, so two answers
 * either side of local midnight are not repeats.
 */
async function repeatOf(db: Prisma.TransactionClient, userId: string, topicId: string, target: RecallTarget, timeZone: string, now = new Date()): Promise<'seen' | 'revealed' | null> {
  const recent = await db.recallAttempt.findMany({
    // 48 hours reach back over any local day boundary.
    where: { userId, topicId, createdAt: { gte: new Date(now.getTime() - 48 * 3_600_000) } },
    select: { createdAt: true, result: true },
  })
  const today = localDay(now, timeZone)
  const covered = new Set(target.concepts.map((concept) => concept.id))
  const same = recent.filter((a) => localDay(a.createdAt, timeZone) === today && [...gradedConceptIds(a.result)].some((id) => covered.has(id)))
  if (same.length === 0) return null
  return same.some((a) => isRecord(a.result) && typeof a.result.revealedAt === 'string') ? 'revealed' : 'seen'
}

export async function submitRecall(input: SubmitInput, grade: (request: RecallGradeRequest) => Promise<RecallGradeAnswer> = requestRecallGrade): Promise<SubmitResult> {
  const { userId, topicId } = input
  const topic = await prisma.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { id: true, projectId: true } })
  if (!topic) return { status: 'not_found' }
  const answer = input.answer.trim()
  if (!answer && input.idk !== true) return { status: 'invalid', message: 'Write what you remember first.' }
  if (answer.length > MAX_RECALL_ANSWER_CHARS) return { status: 'invalid', message: `Keep it under ${MAX_RECALL_ANSWER_CHARS} characters.` }

  const [concepts, prompts] = await Promise.all([loadRecallConcepts(topicId), loadRecallPrompts(topicId)])
  const resolved = resolveTarget(concepts, prompts, input)
  if (!resolved) return { status: 'not_ready' }
  const target = withItemKey(topicId, resolved)
  if (input.idk === true || isDontKnow(answer)) return submitDontRemember(input, topic.projectId, target, answer)

  // Nothing is stored before the grader answers: a 503 leaves the student's text for them to send again.
  const request = gradeRequest({ ...input, answer }, target, topic.projectId)
  const graded = await grade(request)
  if (graded.status !== 'graded') {
    return { status: 'ungraded', clarifyingQuestion: text(graded.clarifying_question) ?? DEFAULT_QUESTION }
  }

  const sent = new Set(request.claims.map((claim) => claim.id))
  const conceptOf = new Map(request.claims.map((claim) => [claim.id, claim.concept_id]))
  const verdicts = graded.verdicts.filter((v) => sent.has(v.claim_id) && VERDICTS.includes(v.verdict))
  if (verdicts.length === 0) return { status: 'ungraded', clarifyingQuestion: DEFAULT_QUESTION }

  const stored: StoredClaim[] = verdicts.map((v: RecallClaimVerdict) => ({
    claim_id: v.claim_id,
    concept_id: conceptOf.get(v.claim_id) ?? '',
    verdict: v.verdict,
    student_quote: text(v.student_quote),
    misconception: text(v.misconception),
    kind: MISS_KINDS.find((k) => k === v.kind) ?? null,
    pointer: text(v.pointer),
    reasoning_gap: typeof v.reasoning_gap === 'boolean' ? v.reasoning_gap : null,
  }))
  // The repeat check and the insert share one lock per student and topic (the check reads every card's attempts), so
  // two answers sent together cannot both be a first try.
  const { attempt, repeat, result } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`recall:${userId}:${topicId}`}, 0))`
    const repeat = await repeatOf(tx, userId, topicId, target, input.timeZone)
    const result = {
      status: 'graded',
      abandoned: input.abandoned,
      ...(repeat ? { repeat } : {}),
      confidence: graded.confidence,
      ...(target.conceptId ? { conceptId: target.conceptId } : {}),
      claims: stored,
    }
    const attempt = await tx.recallAttempt.create({
      data: {
        userId,
        topicId,
        kind: target.kind,
        promptText: target.prompt,
        objectiveIndex: target.objectiveIndex,
        answerText: answer,
        mode: input.inputMode,
        result: asJson(result),
      },
      select: { id: true },
    })
    return { attempt, repeat, result }
  })

  const scores = conceptRecallScores(
    stored.map((claim) => ({ conceptId: claim.concept_id, verdict: claim.verdict, kind: claim.kind, misconception: claim.misconception }))
  )
  try {
    await recordEvidence(
      recallEvidence({
        userId,
        projectId: topic.projectId,
        topicId,
        kind: target.kind,
        itemKey: target.itemKey,
        attemptId: attempt.id,
        abandoned: input.abandoned,
        repeat,
        scores,
      }),
      { timeZone: input.timeZone, userId }
    )
  } catch (error) {
    // No attempt without its evidence: a retry starts clean.
    await prisma.recallAttempt.delete({ where: { id: attempt.id } }).catch(() => undefined)
    throw error
  }

  // The first level-0 graded recall is the "learned" signal (and opens the explainer, §5.4). An answer given with the
  // reading open, or a second try after seeing feedback, is not one; a teach-back comes later and does not move it.
  if (target.kind === 'recall' && !input.abandoned && !repeat) {
    await prisma.topicProgress.upsert({ where: { topicId_userId: { topicId, userId } }, create: { topicId, userId, recallAt: new Date() }, update: {} })
    // Set once, whoever gets here first.
    await prisma.topicProgress.updateMany({ where: { topicId, userId, recallAt: null }, data: { recallAt: new Date() } })
  }
  return { status: 'graded', feedback: await withHelp(userId, topicId, buildFeedback(attempt.id, result, claimLookup(target.concepts)), result), claims: stored, repeat }
}

/**
 * "I don't remember" (spec 18.3): no grader call. Every claim of the card is missing, level-1 evidence goes on every
 * concept of the card, and the first one sets `recallAt`. Nothing stays stored if the evidence cannot be written.
 */
async function submitDontRemember(input: SubmitInput, projectId: string, target: RecallTarget, typed: string): Promise<SubmitResult> {
  const { userId, topicId } = input
  const stored: StoredClaim[] = target.concepts.flatMap((concept) =>
    concept.claims.map((claim) => ({ claim_id: claim.id, concept_id: concept.id, verdict: 'missing' as const, student_quote: null, misconception: null, kind: 'cue_miss' as MissKind, pointer: null, reasoning_gap: null }))
  )
  const result = { status: 'graded', idk: true, abandoned: input.abandoned, ...(target.conceptId ? { conceptId: target.conceptId } : {}), claims: stored }
  const attempt = await prisma.recallAttempt.create({
    data: {
      userId,
      topicId,
      kind: target.kind,
      promptText: target.prompt,
      objectiveIndex: target.objectiveIndex,
      answerText: typed || "I don't remember",
      mode: input.inputMode,
      result: asJson(result),
    },
    select: { id: true },
  })
  try {
    await recordEvidence(
      recallIdkEvidence({ userId, projectId, topicId, kind: target.kind, itemKey: target.itemKey, attemptId: attempt.id, conceptIds: target.concepts.map((concept) => concept.id) }),
      { timeZone: input.timeZone, userId }
    )
  } catch (error) {
    await prisma.recallAttempt.delete({ where: { id: attempt.id } }).catch(() => undefined)
    throw error
  }
  // Set once, whoever gets here first. An honest "I don't remember" opens the way on, whether or not the reading was open.
  if (target.kind === 'recall') {
    await prisma.topicProgress.upsert({ where: { topicId_userId: { topicId, userId } }, create: { topicId, userId, recallAt: new Date() }, update: {} })
    await prisma.topicProgress.updateMany({ where: { topicId, userId, recallAt: null }, data: { recallAt: new Date() } })
  }
  const feedback = await withHelp(userId, topicId, buildFeedback(attempt.id, result, claimLookup(target.concepts)), result)
  return { status: 'graded', feedback, claims: stored, repeat: null }
}

// ------------------------------------------------------------------------------------------ "Show me what I missed"

export type RevealResult = { status: 'ok'; revealed: RevealedClaim[] } | { status: 'not_found' }

/** Shows the claims the answer did not cover and records level 3 on their concepts. Once per attempt. */
export async function revealMissed(input: { userId: string; topicId: string; attemptId: string; timeZone: string }): Promise<RevealResult> {
  const { userId, topicId, attemptId } = input
  const attempt = await prisma.recallAttempt.findFirst({
    where: { id: attemptId, userId, topicId },
    select: { id: true, kind: true, objectiveIndex: true, result: true, topic: { select: { projectId: true } } },
  })
  if (!attempt || !isRecord(attempt.result)) return { status: 'not_found' }

  const concepts = await loadRecallConcepts(topicId)
  const stored = readStoredClaims(attempt.result)
  const revealed = revealedClaims(stored, claimLookup(concepts))
  const conceptIds = [...new Set(stored.filter((claim) => claim.verdict !== 'covered').map((claim) => claim.concept_id).filter(Boolean))]
  if (conceptIds.length > 0) {
    const conceptId = text(attempt.result.conceptId)
    const key =
      attempt.kind === 'teach_back'
        ? itemKey({ kind: 'teach_back', topicId, conceptId: conceptId ?? 'all' })
        : itemKey({ kind: 'recall', topicId, objective: attempt.objectiveIndex ?? 'all' })
    await recordEvidence(
      revealEvidence({ userId, projectId: attempt.topic.projectId, topicId, kind: attempt.kind === 'teach_back' ? 'teach_back' : 'recall', itemKey: key, attemptId, conceptIds }),
      { timeZone: input.timeZone, userId, skipIfPresent: true }
    )
  }
  if (typeof attempt.result.revealedAt !== 'string') {
    await prisma.recallAttempt.update({ where: { id: attemptId }, data: { result: asJson({ ...attempt.result, revealedAt: new Date().toISOString() }) } })
  }
  return { status: 'ok', revealed }
}
