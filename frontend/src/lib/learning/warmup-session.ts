/**
 * The warm-up before reading (spec §5.1, D7). An `ItemSession` of kind warmup, never a quiz attempt.
 *
 * - `items` snapshots the topic's warm-up bank as served, with the answer keys, so regenerating the bank
 *   later cannot change what was graded. The browser only gets the public form of the question it is on.
 * - `results` is the session's state: how many questions the student answers, the order they were served
 *   in, and each graded answer.
 * - The bank has five questions tagged easy, medium or hard and the student answers three, chosen by
 *   `nextWarmupDifficulty`. Whether an answer was right is not shown until the last one: the bracket runs on
 *   the server, so the next question does not tell the student how they did.
 *
 * Every answer writes level-0 evidence with `source=warmup` straight away (it sets the concepts' inferred
 * prior, nothing is taught yet so no memory card moves). "I don't know" (spec 18.3) is an answer too: graded wrong
 * without a grader, with no confidence, and the bracket steps down. The last answer finishes the session and sets
 * `TopicProgress.warmupAt`.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { gradeAnswers } from '@/lib/ai-service/grading'
import { recordEvidence } from './evidence'
import { normalizeAnswers, answersForGrader, type QuizAnswer } from './quiz-answers'
import { buildGradedEvidence } from './quiz-evidence'
import { dontKnowEvidence } from './dont-know'
import { WARMUP_IDK_ANSWER } from './warmup-idk'
import { asQuestionList, toPublicQuestion, type PublicQuizQuestion } from './quiz-questions'
import { buildReview, toStoredResults, type QuizReviewItem } from './quiz-review'
import { itemKey } from './item-key'
import { nextWarmupDifficulty, offersTestOut, pickWarmupItem, WARMUP_LENGTH, type WarmupDifficulty, type WarmupResult } from './warmup-bracket'
import type { SourceRef } from '@/lib/topics/sources'

type RawQuestion = Record<string, unknown>

const LEVELS: WarmupDifficulty[] = ['easy', 'medium', 'hard']
const CHOICE_TYPES = new Set(['multiple_choice', 'true_false'])

type WarmupItem = { index: number; itemKey: string; difficulty: WarmupDifficulty; conceptIds: string[]; question: RawQuestion }

type GradedWarmup = {
  answer: string
  confidence?: number
  confidenceLevel?: string
  score: number
  correct: boolean
  /** "I don't know": no answer, no confidence, graded wrong. */
  idk?: boolean
  review: QuizReviewItem
}

type Meta = { topicId: string; total: number; order: number[]; graded: Record<string, GradedWarmup> }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function readMeta(value: unknown): Meta {
  const base: Meta = { topicId: '', total: WARMUP_LENGTH, order: [], graded: {} }
  if (!isRecord(value)) return base
  return {
    topicId: typeof value.topicId === 'string' ? value.topicId : '',
    total: typeof value.total === 'number' ? value.total : WARMUP_LENGTH,
    order: Array.isArray(value.order) ? value.order.filter((n): n is number => typeof n === 'number') : [],
    graded: isRecord(value.graded) ? (value.graded as Record<string, GradedWarmup>) : {},
  }
}

const readItems = (value: unknown): WarmupItem[] => (Array.isArray(value) ? (value.filter(isRecord) as unknown as WarmupItem[]) : [])

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

const lockSession = (tx: Prisma.TransactionClient, sessionId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`item_session:${sessionId}`}))`

// ------------------------------------------------------------------------------------------ the state

export type WarmupDoneItem = {
  /** 1-based place in the warm-up. */
  position: number
  question: PublicQuizQuestion
  answer: string
  confidence?: number
  confidenceLevel?: string
  correct: boolean
  /** The student said "I don't know". */
  idk: boolean
  correctAnswer: string
  /** Where in the files the question is based on: "You'll find this on p. N". */
  sources: SourceRef[]
}

export type WarmupState =
  /** No warm-up bank for this topic. */
  | { status: 'none' }
  | { status: 'ready'; total: number }
  | { status: 'asking'; sessionId: string; position: number; total: number; index: number; question: PublicQuizQuestion }
  | { status: 'done'; sessionId: string; total: number; items: WarmupDoneItem[]; testOut: boolean }

/** A question as the student sees it: no key, and not the level the bracket put it at. */
function publicQuestion(question: RawQuestion): PublicQuizQuestion {
  const { difficulty: _level, concepts_tested: _tested, ...shown } = toPublicQuestion(question)
  return shown as PublicQuizQuestion
}

function toResults(items: WarmupItem[], meta: Meta): WarmupResult[] {
  return meta.order.flatMap((index) => {
    const graded = meta.graded[String(index)]
    const item = items.find((candidate) => candidate.index === index)
    if (!graded || !item) return []
    return [{ conceptIds: item.conceptIds, correct: graded.correct, confidence: graded.confidence, confidenceLevel: graded.confidenceLevel }]
  })
}

function stateOf(row: { id: string; items: Prisma.JsonValue; results: Prisma.JsonValue; completedAt: Date | null }): WarmupState {
  const items = readItems(row.items)
  const meta = readMeta(row.results)
  if (row.completedAt) {
    const done: WarmupDoneItem[] = meta.order.flatMap((index, position) => {
      const graded = meta.graded[String(index)]
      const item = items.find((candidate) => candidate.index === index)
      if (!graded || !item) return []
      return [
        {
          position: position + 1,
          question: publicQuestion(item.question),
          answer: graded.answer,
          ...(graded.confidence !== undefined ? { confidence: graded.confidence } : {}),
          ...(graded.confidenceLevel ? { confidenceLevel: graded.confidenceLevel } : {}),
          correct: graded.correct,
          idk: graded.idk === true,
          correctAnswer: graded.review.correctAnswer,
          sources: graded.review.sources,
        },
      ]
    })
    return { status: 'done', sessionId: row.id, total: meta.total, items: done, testOut: offersTestOut(toResults(items, meta)) }
  }
  const index = meta.order[meta.order.length - 1]
  const item = items.find((candidate) => candidate.index === index)
  if (item === undefined) return { status: 'none' }
  return { status: 'asking', sessionId: row.id, position: meta.order.length, total: meta.total, index: item.index, question: publicQuestion(item.question) }
}

// ------------------------------------------------------------------------------------------ the bank

/** The topic's warm-up bank: choice questions with a key and a level, in the order the generator wrote them. */
async function loadBank(topicId: string): Promise<WarmupItem[]> {
  const row = await prisma.topicQuiz.findFirst({ where: { topicId, kind: 'warmup' }, orderBy: { createdAt: 'desc' }, select: { id: true, questions: true } })
  const questions = row ? asQuestionList(row.questions) : null
  if (!row || !questions) return []
  return questions.flatMap((question, index) => {
    if (!CHOICE_TYPES.has(String(question.question_type)) || question.correct_answer === undefined) return []
    const level = String(question.difficulty ?? '').toLowerCase()
    const conceptIds = (Array.isArray(question.concept_ids) ? question.concept_ids : []).filter((id): id is string => typeof id === 'string' && !!id)
    return [
      {
        index,
        itemKey: itemKey({ kind: 'quiz', setId: row.id, index }),
        difficulty: (LEVELS as string[]).includes(level) ? (level as WarmupDifficulty) : 'medium',
        conceptIds,
        question,
      },
    ]
  })
}

const ownedTopic = (userId: string, topicId: string) =>
  prisma.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { id: true, projectId: true } })

const latestSession = (userId: string, topicId: string, completed: boolean) =>
  prisma.itemSession.findFirst({
    where: { userId, kind: 'warmup', topicIds: { has: topicId }, completedAt: completed ? { not: null } : null },
    orderBy: { createdAt: 'desc' },
  })

// ------------------------------------------------------------------------------------------ reading and starting

/** Where the warm-up stands for a topic: not available, ready, being answered, or finished. */
export async function loadWarmupState(userId: string, topicId: string): Promise<WarmupState> {
  const done = await latestSession(userId, topicId, true)
  if (done) return stateOf(done)
  const open = await latestSession(userId, topicId, false)
  if (open) return stateOf(open)
  const bank = await loadBank(topicId)
  return bank.length > 0 ? { status: 'ready', total: Math.min(WARMUP_LENGTH, bank.length) } : { status: 'none' }
}

export type StartResult = { status: 'ok'; state: WarmupState } | { status: 'not_found' }

/**
 * Starts the warm-up: the first question is medium. A warm-up already begun is picked up where it was, and a
 * finished one is shown as it is (the pretest is taken once: it measures what the student knew before reading).
 */
export async function startWarmup(input: { userId: string; topicId: string }): Promise<WarmupState | { status: 'not_found' }> {
  const topic = await ownedTopic(input.userId, input.topicId)
  if (!topic) return { status: 'not_found' }
  const existing = await loadWarmupState(input.userId, input.topicId)
  if (existing.status !== 'ready') return existing

  const bank = await loadBank(input.topicId)
  const first = pickWarmupItem(bank, [], nextWarmupDifficulty(null))
  if (first === null) return { status: 'none' }
  const meta: Meta = { topicId: input.topicId, total: Math.min(WARMUP_LENGTH, bank.length), order: [first], graded: {} }
  const row = await prisma.itemSession.create({
    data: { userId: input.userId, projectId: topic.projectId, kind: 'warmup', topicIds: [input.topicId], items: asJson(bank), answers: {}, results: asJson(meta) },
  })
  return stateOf(row)
}

/** What the warm-up showed about each question the student answered, newest finished warm-up of the topic; null when none finished. */
export async function latestWarmupResults(userId: string, topicId: string): Promise<WarmupResult[] | null> {
  const row = await latestSession(userId, topicId, true)
  if (!row) return null
  return toResults(readItems(row.items), readMeta(row.results))
}

// ------------------------------------------------------------------------------------------ answering

export type AnswerResult = { status: 'ok'; state: WarmupState } | { status: 'not_found' } | { status: 'invalid'; message: string }

/**
 * Grades one answer, writes its evidence and serves the next question (or finishes). Answers come in the
 * order they were served; an answer sent twice grades once. Grading errors (`GradingUnavailableError`,
 * `GradingRejectedError`) reach the caller untouched.
 */
export async function answerWarmup(input: { userId: string; topicId: string; sessionId: string; index: number; answer: unknown; timeZone: string }): Promise<AnswerResult> {
  const { userId, topicId, sessionId, index, timeZone } = input
  const row = await prisma.itemSession.findFirst({ where: { id: sessionId, userId, kind: 'warmup', topicIds: { has: topicId } } })
  if (!row) return { status: 'not_found' }
  const items = readItems(row.items)
  const meta = readMeta(row.results)
  // Sent again after it was graded (a double click, a retry): the state as it stands.
  if (row.completedAt || meta.graded[String(index)]) return { status: 'ok', state: stateOf(row) }
  if (index !== meta.order[meta.order.length - 1]) return { status: 'invalid', message: 'Answer the question that is open.' }
  const item = items.find((candidate) => candidate.index === index)
  if (!item) return { status: 'invalid', message: 'There is no such question in this warm-up.' }
  const given = normalizeAnswers({ '0': input.answer })['0']
  if (!given || !given.answer.trim()) return { status: 'invalid', message: 'Give an answer first.' }
  const idk = given.answer === WARMUP_IDK_ANSWER
  // Confidence is optional here as it is everywhere (a one-tap rating when the student gives one). It is what the bracket and the
  // test-out offer read, so an answer without it keeps the level and never offers the test-out: only rated answers count as sure.
  // "I don't know" has none: nothing was chosen to be sure of.

  // An "I don't know" is wrong by rule: no grader, so it works with the AI down.
  const result = idk
    ? { question_index: 0, question_type: String(item.question.question_type ?? 'multiple_choice'), points_possible: 1, points_earned: 0, is_correct: false, feedback: '', needs_review: false }
    : (await gradeAnswers([item.question], answersForGrader({ '0': given }))).graded_questions[0]
  if (!result) return { status: 'invalid', message: 'This question could not be graded.' }

  // Evidence first and idempotent (skipIfPresent): if the session update below is lost, the answer sent
  // again writes nothing twice.
  const topic = await ownedTopic(userId, topicId)
  if (!topic) return { status: 'not_found' }
  const known = new Set(
    (await prisma.concept.findMany({ where: { id: { in: item.conceptIds }, projectId: topic.projectId, status: 'active' }, select: { id: true } })).map((c) => c.id)
  )
  // Both are a level-0 score on the warm-up source; the IDK one is written by the shared contract (no confidence, cue miss).
  const events = idk
    ? dontKnowEvidence({
        userId,
        projectId: topic.projectId,
        topicId,
        itemKey: item.itemKey,
        conceptIds: item.conceptIds.filter((id) => known.has(id)),
        surface: 'warmup',
        level: 0,
        sessionKey: `warmup:${sessionId}`,
      }).filter((event) => event.conceptIds.length > 0)
    : buildGradedEvidence(
        { userId, projectId: topic.projectId, source: 'warmup', sessionKey: `warmup:${sessionId}`, itemKeyOf: () => item.itemKey, topicOf: () => topicId },
        { questions: [item.question], answers: { '0': given as QuizAnswer }, graded: [{ ...result, question_index: 0 }], knownConceptIds: known }
      )
  if (events.length > 0) await recordEvidence(events, { timeZone, userId, skipIfPresent: true })

  const score = result.points_possible > 0 ? Math.min(1, Math.max(0, result.points_earned / result.points_possible)) : result.is_correct ? 1 : 0
  const review = buildReview([item.question], toStoredResults([{ ...result, question_index: 0 }], idk ? new Set([0]) : undefined), { '0': idk ? '' : given.answer })[0]
  // A warm-up explains nothing: the reading supplies it.
  const shown: QuizReviewItem = { ...review, questionIndex: index, explanation: '', feedback: null }

  const state = await prisma.$transaction(
    async (tx) => {
      await lockSession(tx, sessionId)
      const fresh = await tx.itemSession.findFirst({ where: { id: sessionId, userId } })
      if (!fresh) return null
      const freshMeta = readMeta(fresh.results)
      if (fresh.completedAt || freshMeta.graded[String(index)]) return stateOf(fresh)
      freshMeta.graded[String(index)] = {
        answer: idk ? '' : given.answer,
        ...(!idk && given.confidence !== undefined ? { confidence: given.confidence } : {}),
        ...(!idk && given.confidenceLevel ? { confidenceLevel: given.confidenceLevel } : {}),
        score,
        correct: score >= 0.75,
        ...(idk ? { idk: true } : {}),
        review: shown,
      }
      let completedAt: Date | null = null
      if (Object.keys(freshMeta.graded).length >= freshMeta.total) {
        completedAt = new Date()
      } else {
        const next = pickWarmupItem(items, freshMeta.order, nextWarmupDifficulty({ difficulty: item.difficulty, correct: score >= 0.75, ...(idk ? {} : { confidence: given.confidence, confidenceLevel: given.confidenceLevel }) }))
        if (next === null) completedAt = new Date()
        else freshMeta.order.push(next)
      }
      const answers = isRecord(fresh.answers) ? { ...fresh.answers } : {}
      answers[String(index)] = idk ? { answer: '', idk: true } : given
      const updated = await tx.itemSession.update({
        where: { id: sessionId },
        data: { results: asJson(freshMeta), answers: asJson(answers), ...(completedAt ? { completedAt } : {}) },
      })
      if (completedAt) {
        // The attempt sets warmupAt (spec §5.1); the first one stands.
        await tx.topicProgress.upsert({
          where: { topicId_userId: { topicId, userId } },
          create: { topicId, userId, warmupAt: completedAt, lastAccessedAt: completedAt },
          update: { lastAccessedAt: completedAt },
        })
        await tx.topicProgress.updateMany({ where: { topicId, userId, warmupAt: null }, data: { warmupAt: completedAt } })
      }
      return stateOf(updated)
    },
    { timeout: 20_000, maxWait: 15_000 }
  )
  return state ? { status: 'ok', state } : { status: 'not_found' }
}
