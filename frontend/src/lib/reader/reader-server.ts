/**
 * The reader's ways of writing learning evidence, and its tutor (spec §3.3, §5.2, §18.6). Server only.
 *
 * - "Explain this passage" is attempt-first: the student writes what they think the passage says, or what
 *   confuses them, in at least 8 characters, or taps "I can't parse any of it" (which counts as an attempt).
 *   The tutor then answers about that passage only, at a rung that rises with each further question on it, and
 *   ends with one check question. The exchange is stored as a margin note of kind question, and the passage's
 *   concepts get level-3 evidence: the AI carried it, so no memory review and no score.
 * - A passage's tutor state is `TutorState(scope='reader', scopeKey='<topicId>:<chunkId>')`: the rung (the number of
 *   explanations it has had) and `cantParseTurns`. The second "I can't parse any of it" on a passage is answered with a
 *   plain restatement (rung 4), which also writes a `restatement` instruction event. A passage gets four tutor
 *   replies a local day.
 * - The check question can be answered (or "I don't know"). The reply is a verdict (Right, Partly, Not yet) and,
 *   when it is not right, one more question. The answer is stored as a margin note of kind answer, linked to the
 *   note it answers, and recorded at level 2 for display: it was given right after an explanation, so it never
 *   moves the memory.
 * - A "Quick check" check is self-graded (Got it, Partly, Missed): level 2, for display, never memory.
 */

import { ownedTopic } from '@/server/owned'
import { prisma } from '@/lib/db/prisma'
import { postTutor, requestReaderTutor, type ReaderTutorAnswer, type ReaderTutorRequest } from '@/lib/ai-service/tutor'
import { dontKnowEvidence, isDontKnow } from '@/lib/learning/dont-know'
import { recordEvidence } from '@/lib/learning/evidence'
import { recordInstruction } from '@/lib/learning/instruction-server'
import { localDateParts, zonedTimeToUtc } from '@/lib/learning/study-plan-time'
import { checkScore, type CheckGrade } from './checks'
import {
  CANT_PARSE_TEXT,
  CHECK_DONT_KNOW_TEXT,
  isAttempt,
  MAX_REPLIES_PER_DAY,
  MIN_TAKE_CHARS,
  RESTATE_AFTER_CANT_PARSE,
  RESTATE_RUNG,
  VERDICT_SCORES,
  type CheckVerdict,
} from './take'
import { claimsOnChunk, toNoteView, type MarginNoteView } from './load-reader'

const MAX_TAKE_CHARS = 2000
const MAX_RUNG = 3
/** Longest passage sent to the tutor (a chunk is about 2000 characters). */
const MAX_PASSAGE_CHARS = 5000
const MAX_CLAIMS = 8
const MAX_QUOTE_CHARS = 300
/** A thread of answers is followed back to the question that started it at most this far. */
const MAX_THREAD_DEPTH = 8

/** The body of POST /tutor/reader for an explanation or a restatement (ai-service ReaderTutorRequest). */
export type ReaderTurnRequest = ReaderTutorRequest & { turn: 'explain' | 'restate' }
/** The body for the student's answer to a check question. */
export type ReaderCheckRequest = ReaderTutorRequest & { turn: 'check'; check_question: string; student_answer: string; dont_know: boolean }
/** The verdict reply. `from_fallback` means the tutor could not make a verdict from the answer (a reply held back twice). */
export type ReaderCheckAnswer = { verdict: CheckVerdict; reply: string; follow_up_question: string; from_fallback: boolean }

export const requestReaderCheck = (request: ReaderCheckRequest): Promise<ReaderCheckAnswer> => postTutor('/tutor/reader', request)

export type ExplainResult =
  | { status: 'ok'; note: MarginNoteView }
  | { status: 'not_found' }
  | { status: 'invalid'; message: string }
  | { status: 'limit' }

/** The rung a question on a passage may use: the first reply locates, and each further question on it opens the next. */
export const readerRung = (earlierQuestions: number): number => Math.min(MAX_RUNG, 1 + earlierQuestions)

const stateWhere = (userId: string, topicId: string, chunkId: string) => ({ userId_scope_scopeKey: { userId, scope: 'reader', scopeKey: `${topicId}:${chunkId}` } })

/** The tutor replies this passage has had since the start of the student's local day. */
async function repliesToday(userId: string, topicId: string, chunkId: string, timeZone: string): Promise<number> {
  const start = zonedTimeToUtc(localDateParts(new Date(), timeZone), 0, 0, timeZone)
  return prisma.marginNote.count({ where: { userId, topicId, chunkId, kind: { in: ['question', 'answer'] }, createdAt: { gte: start } } })
}

export async function explainPassage(
  input: { userId: string; topicId: string; chunkId: string; take: string; cantParse: boolean; timeZone: string },
  ask: (request: ReaderTurnRequest) => Promise<ReaderTutorAnswer> = requestReaderTutor
): Promise<ExplainResult> {
  const { userId, topicId, chunkId } = input
  const topic = await ownedTopic(userId, topicId)
  if (!topic) return { status: 'not_found' }
  const chunk = await prisma.materialChunk.findFirst({ where: { id: chunkId, material: { projectId: topic.projectId } }, select: { chunkText: true, materialId: true } })
  if (!chunk) return { status: 'not_found' }

  // The attempt comes first: nothing is explained to a student who has written nothing.
  const take = input.cantParse ? CANT_PARSE_TEXT : input.take.trim().slice(0, MAX_TAKE_CHARS)
  if (!input.cantParse && !isAttempt(take)) {
    return { status: 'invalid', message: `Write at least ${MIN_TAKE_CHARS} characters about what you think this passage says, or tap "${CANT_PARSE_TEXT}".` }
  }
  if ((await repliesToday(userId, topicId, chunkId, input.timeZone)) >= MAX_REPLIES_PER_DAY) return { status: 'limit' }

  const claims = await claimsOnChunk(topic, chunkId)
  // The rung and the can't-parse count are the passage's tutor state, read before the reply and moved after it.
  const state = await prisma.tutorState.findUnique({ where: stateWhere(userId, topicId, chunkId) })
  const earlier = state?.attempts ?? 0
  const cantParseTurns = (state?.cantParseTurns ?? 0) + (input.cantParse ? 1 : 0)
  const restating = input.cantParse && cantParseTurns >= RESTATE_AFTER_CANT_PARSE
  const rung = restating ? RESTATE_RUNG : readerRung(earlier)
  const answer = await ask({
    passage: chunk.chunkText.slice(0, MAX_PASSAGE_CHARS),
    chunk_id: chunkId,
    student_take: take,
    cant_parse: input.cantParse,
    rung,
    turn: restating ? 'restate' : 'explain',
    claims: claims.slice(0, MAX_CLAIMS).map((claim) => ({
      text: claim.text,
      quote: claim.quote.slice(0, MAX_QUOTE_CHARS),
      ...(claim.pageStart !== null ? { page: claim.pageStart } : {}),
    })),
    user_id: userId,
    project_id: topic.projectId,
    session_id: chunkId,
  })

  const note = await prisma.marginNote.create({
    data: {
      userId,
      topicId,
      materialId: chunk.materialId,
      chunkId,
      kind: 'question',
      text: take,
      reply: { reply: answer.reply, checkQuestion: answer.check_question, rung },
    },
    select: { id: true, chunkId: true, kind: true, text: true, reply: true, createdAt: true },
  })

  // Level 3: the concepts the passage carries were explained by the AI. A topic without concepts writes none.
  const conceptIds = [...new Set(claims.map((claim) => claim.conceptId))]
  try {
    if (conceptIds.length > 0) {
      await recordEvidence(
        [
          {
            userId,
            projectId: topic.projectId,
            topicId,
            itemKey: `reader:${chunkId}:explain`,
            conceptIds,
            source: 'reader',
            score: 0,
            assistance: 3,
            gradedBy: 'rule',
            sessionKey: `reader-explain:${note.id}`,
            metadata: { chunkId, explained: true, rung, ...(restating ? { restated: true } : {}) },
          },
        ],
        { timeZone: input.timeZone, userId }
      )
      // A restatement is instruction after two failed reads of the passage (spec 18.5): its own event, once a local day.
      if (restating) await recordInstruction(prisma, { userId, topicId, kind: 'restatement', conceptIds, ref: chunkId, timeZone: input.timeZone })
    }
    // The state moves last, so a reply that failed costs the student no rung.
    const data = { attempts: earlier + 1, rung, maxRung: Math.max(state?.maxRung ?? 0, rung), cantParseTurns }
    await prisma.tutorState.upsert({
      where: stateWhere(userId, topicId, chunkId),
      create: { userId, scope: 'reader', scopeKey: `${topicId}:${chunkId}`, conceptIds, ...data },
      update: { ...data, conceptIds },
    })
  } catch (error) {
    // No exchange without its evidence: a retry starts clean.
    await prisma.marginNote.delete({ where: { id: note.id } }).catch(() => undefined)
    throw error
  }
  return { status: 'ok', note: toNoteView(note) }
}

export type AnswerResult =
  | { status: 'ok'; note: MarginNoteView; verdict: CheckVerdict | null }
  | { status: 'not_found' }
  | { status: 'invalid'; message: string }
  /** The question already has its answer. */
  | { status: 'answered' }
  | { status: 'limit' }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The student's answer to a check question (or "I don't know", the button or typed), as a margin note of kind answer and
 * the tutor's verdict on it. The note answered is the question note or an earlier answer note whose reply ended with a
 * follow-up question. The answer is level 2 (right after an explanation), source reader, scored 1, 0.5 or 0 by the
 * verdict for display; an "I don't know" is the same level with score 0 and no confidence. A reply the tutor could not
 * check (`from_fallback`) is stored without a verdict and records nothing.
 */
export async function answerReaderCheck(
  userId: string,
  topicId: string,
  input: { noteId: string; answer?: string; dontKnow?: boolean; timeZone?: string },
  ask: (request: ReaderCheckRequest) => Promise<ReaderCheckAnswer> = requestReaderCheck
): Promise<AnswerResult> {
  const timeZone = input.timeZone ?? 'UTC'
  const topic = await ownedTopic(userId, topicId)
  if (!topic) return { status: 'not_found' }
  const asked = await prisma.marginNote.findFirst({
    where: { id: input.noteId, userId, topicId, kind: { in: ['question', 'answer'] } },
    select: { id: true, chunkId: true, materialId: true, reply: true },
  })
  const checkQuestion = asked && isRecord(asked.reply) && typeof asked.reply.checkQuestion === 'string' ? asked.reply.checkQuestion.trim() : ''
  if (!asked || checkQuestion === '') return { status: 'not_found' }
  const chunk = await prisma.materialChunk.findFirst({ where: { id: asked.chunkId, material: { projectId: topic.projectId } }, select: { chunkText: true } })
  if (!chunk) return { status: 'not_found' }

  // An empty answer is neither an answer nor an "I don't know"; a typed "idk" is the button.
  const typed = (input.answer ?? '').trim().slice(0, MAX_TAKE_CHARS)
  if (input.dontKnow !== true && typed === '') return { status: 'invalid', message: 'Write an answer, or tap "I don\'t know".' }
  const dontKnow = input.dontKnow === true || isDontKnow(typed)
  const answerText = dontKnow && typed === '' ? CHECK_DONT_KNOW_TEXT : typed

  if ((await prisma.marginNote.count({ where: { userId, topicId, kind: 'answer', reply: { path: ['parentNoteId'], equals: asked.id } } })) > 0) return { status: 'answered' }
  if ((await repliesToday(userId, topicId, asked.chunkId, timeZone)) >= MAX_REPLIES_PER_DAY) return { status: 'limit' }

  // The take that started the thread: the question note at its root.
  let root: { text: string; reply: unknown; id: string; kind: string } | null = await prisma.marginNote.findUnique({ where: { id: asked.id }, select: { id: true, kind: true, text: true, reply: true } })
  for (let depth = 0; root && root.kind === 'answer' && depth < MAX_THREAD_DEPTH; depth += 1) {
    const parentId: unknown = isRecord(root.reply) ? root.reply.parentNoteId : null
    root = typeof parentId === 'string' ? await prisma.marginNote.findUnique({ where: { id: parentId }, select: { id: true, kind: true, text: true, reply: true } }) : null
  }
  const take = root?.text ?? CANT_PARSE_TEXT

  const claims = await claimsOnChunk(topic, asked.chunkId)
  const state = await prisma.tutorState.findUnique({ where: stateWhere(userId, topicId, asked.chunkId), select: { rung: true } })
  const result = await ask({
    passage: chunk.chunkText.slice(0, MAX_PASSAGE_CHARS),
    chunk_id: asked.chunkId,
    student_take: take,
    cant_parse: false,
    rung: Math.min(5, Math.max(0, state?.rung ?? 1)),
    turn: 'check',
    check_question: checkQuestion,
    student_answer: dontKnow ? CHECK_DONT_KNOW_TEXT : typed,
    dont_know: dontKnow,
    claims: claims.slice(0, MAX_CLAIMS).map((claim) => ({
      text: claim.text,
      quote: claim.quote.slice(0, MAX_QUOTE_CHARS),
      ...(claim.pageStart !== null ? { page: claim.pageStart } : {}),
    })),
    user_id: userId,
    project_id: topic.projectId,
    session_id: asked.chunkId,
  })

  // A verdict the tutor could not make from the answer is not shown as one, and scores nothing.
  const verdict: CheckVerdict | null = result.from_fallback ? null : dontKnow ? 'not_yet' : result.verdict
  const followUp = verdict === 'right' ? '' : result.follow_up_question
  const note = await prisma.marginNote.create({
    data: {
      userId,
      topicId,
      materialId: asked.materialId,
      chunkId: asked.chunkId,
      kind: 'answer',
      text: answerText,
      reply: { reply: result.reply, checkQuestion: followUp, verdict, parentNoteId: asked.id },
    },
    select: { id: true, chunkId: true, kind: true, text: true, reply: true, createdAt: true },
  })

  const conceptIds = [...new Set(claims.map((claim) => claim.conceptId))]
  if (verdict && conceptIds.length > 0) {
    const base = { userId, projectId: topic.projectId, topicId, itemKey: `reader:${asked.chunkId}:answer:${asked.id}`, conceptIds, sessionKey: `reader-answer:${note.id}` }
    try {
      await recordEvidence(
        dontKnow
          ? dontKnowEvidence({ ...base, surface: 'reader', level: 2, metadata: { chunkId: asked.chunkId, noteId: asked.id } })
          : [{ ...base, source: 'reader', score: VERDICT_SCORES[verdict], assistance: 2, gradedBy: 'model', metadata: { chunkId: asked.chunkId, verdict } }],
        { timeZone, userId }
      )
    } catch (error) {
      // No exchange without its evidence: a retry starts clean.
      await prisma.marginNote.delete({ where: { id: note.id } }).catch(() => undefined)
      throw error
    }
  }
  return { status: 'ok', note: toNoteView(note), verdict }
}

export type CheckResult = { status: 'ok'; recorded: boolean } | { status: 'not_found' }

/** The sentence in the student's file a check reveals, and its page. Asked for when the student shows the source. */
export async function revealCheckSource(input: { userId: string; topicId: string; claimId: string }): Promise<{ quote: string; pageStart: number | null } | null> {
  const claim = await prisma.conceptClaim.findFirst({
    where: { id: input.claimId, concept: { topicId: input.topicId, status: 'active', project: { userId: input.userId } } },
    select: { quote: true, pageStart: true },
  })
  return claim ? { quote: claim.quote, pageStart: claim.pageStart } : null
}

/** A "Quick check" self-grade: level 2, graded by the student, for display. Recorded once per claim. */
export async function recordReaderCheck(input: { userId: string; topicId: string; claimId: string; grade: CheckGrade; timeZone: string }): Promise<CheckResult> {
  const { userId, topicId, claimId } = input
  const claim = await prisma.conceptClaim.findFirst({
    where: { id: claimId, concept: { topicId, status: 'active', project: { userId } } },
    select: { conceptId: true, concept: { select: { projectId: true } } },
  })
  if (!claim) return { status: 'not_found' }
  const itemKey = `reader:${claimId}:check`
  // The first grade stands: a check graded again (after the page was reopened in a new session) is not counted twice.
  if (await prisma.evidenceEvent.findFirst({ where: { userId, itemKey, source: 'reader' }, select: { id: true } })) return { status: 'ok', recorded: false }
  await recordEvidence(
    [
      {
        userId,
        projectId: claim.concept.projectId,
        topicId,
        itemKey,
        conceptIds: [claim.conceptId],
        source: 'reader',
        score: checkScore(input.grade),
        assistance: 2,
        gradedBy: 'self',
        sessionKey: `reader:${topicId}`,
        metadata: { grade: input.grade },
      },
    ],
    { timeZone: input.timeZone, userId, skipIfPresent: true }
  )
  return { status: 'ok', recorded: true }
}
