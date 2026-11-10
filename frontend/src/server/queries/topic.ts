import { cache } from 'react'
import { prisma } from '@/lib/db/prisma'
import { pickGenerationFailures } from '@/lib/jobs/failure-message'
import { asQuestionList, toPublicQuestions, type PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { buildReview, type QuizReviewItem } from '@/lib/learning/quiz-review'
import { masteryLevel, type MasteryLevel } from '@/lib/mastery'
import type { ConceptLabel } from '@/lib/learning/concept-mastery'
import { retryOpensAt } from '@/lib/learning/missed'
import { getTimeZone } from '@/server/timezone'
import { convertTopicIfDue } from '@/lib/learning/backfill'
import { getLastAttemptAt, getMissedQuestions } from '@/lib/learning/review-server'
import { getWaitingQuizzes, type WaitingQuiz } from '@/lib/learning/quiz-submissions'
import { practiceRowProgress } from '@/lib/learning/practice-server'
import { mergeSources, type SourceRef } from '@/lib/topics/sources'
import { parseNotes, parsePracticeProblems, parseSolvedExamples } from '@/features/topic/content'
import type { ProblemProgress } from '@/features/topic/practice-keys'
import {
  CONTENT_TYPE_BY_KIND,
  KIND_BY_CONTENT_TYPE,
  type ContentKind,
  type ExamplesContent,
  type NotesContent,
  type PracticeContent,
} from '@/features/topic/types'
import { topicBand, type Band } from '@/lib/learning/level'
import type { NextActivity } from '@/lib/learning/next-activity'
import { loadTopicLearningState, resolveTopicActivity } from '@/lib/learning/next-activity-server'
import { loadRecallProgress } from '@/lib/learning/recall-server'
import { findActiveConceptsJob, preparationInFlight } from '@/lib/learning/topic-preparation'
import { pathSteps } from '@/features/topic/path-steps'
import type { PathView } from '@/features/topic/types'
import { getCourseShell } from './courses'

/**
 * The read model of the topic page. Everything is filtered by the user id. Quiz sets are read
 * here (no API lists them) and go through `toPublicQuestions`, so an answer key never reaches
 * the browser before a quiz is submitted. Past attempts are already graded, so their review
 * (which carries the key) is included, as the quiz-attempts route does.
 */

export type QuizSetData = {
  /** The set's id, or "legacy" for the quiz stored before sets existed. */
  id: string
  /** "Set 3": sets are numbered oldest first. A set of missed questions is "Retry". */
  label: string
  /** retry: the questions missed in the last attempts, copied from the sets they came from. */
  kind: 'standard' | 'retry'
  createdAt: string
  questions: PublicQuizQuestion[]
}

export type QuizAttemptData = {
  id: string
  score: number
  takenAt: string
  setId: string
  answers: Record<string, string>
  /** Null when the set it was taken on no longer exists. */
  review: QuizReviewItem[] | null
}

/** Whether a review is due, and what the two review actions have to work with. */
export type TopicReview = {
  /** The review is due by now (the schedule's date has come). */
  due: boolean
  /** Questions missed in the last two attempts: "Retry what you missed" is offered when this is above zero. */
  missedCount: number
  /** When "Retry what you missed" opens (ISO, the start of the next local day after the last attempt), or null. */
  retryOpensAt: string | null
}

export type TopicFailure = { message: string; errorCode: string | null }

export type TopicNeighbour = { id: string; name: string; hasNotes: boolean }

/** Where a topic sits in the course, and what it covers: what the topic header shows. */
export type TopicStructure = {
  /** The unit it belongs to, or null (a flat course, or a topic added by hand). */
  unit: { id: string; title: string; weekLabel: string | null } | null
  /** Verb phrases that finish "By the end you can ...". Empty for topics added by hand. */
  objectives: string[]
  /** Topics this one builds on, in course order, with a name to link to. */
  prerequisites: { id: string; name: string }[]
  estimatedMinutes: number | null
  /** The files the topic is taught from: one entry per file and page range, in document order. */
  sources: SourceRef[]
}

export type TopicPageData = {
  course: { id: string; name: string }
  /** A new topic on a confirmed list: not studied until the student confirms it in the topic editor. */
  awaitingReview: boolean
  topic: {
    id: string
    name: string
    description: string | null
    mastery: number | null
    /** Mastery as earned, before it faded for a late review. */
    earnedMastery: number | null
    masteryLevel: MasteryLevel
    dueAt: string | null
    /** Days until the review is due by the server's clock; zero or less means due now. */
    daysUntilDue: number | null
    progress: { notes: boolean; examples: boolean; quiz: boolean; quizScore: number | null }
    structure: TopicStructure
    /** Key terms from topic finding (empty for topics added by hand). The voice Focus field's example uses one. */
    keywords: string[]
  }
  previous: TopicNeighbour | null
  next: TopicNeighbour | null
  content: {
    notes: NotesContent | null
    examples: ExamplesContent | null
    practice: PracticeContent | null
    quiz: { sets: QuizSetData[]; updatedAt: string } | null
  }
  /** Which content kinds exist, for the tabs. */
  present: Record<ContentKind, boolean>
  /** Changes whenever any content is rewritten, so a client can tell a refresh has landed. */
  contentVersion: string
  attempts: QuizAttemptData[]
  /** Quizzes submitted while the AI could not grade them: stored, and graded when it is back. */
  waitingQuizzes: WaitingQuiz[]
  review: TopicReview
  /** The student's stored progress on the current practice problems (the browser loads it into its cache). */
  practiceProgress: ProblemProgress[]
  /** Kinds whose latest generation failed and that still have no content. */
  failures: Partial<Record<ContentKind, TopicFailure>>
  /** What to do next on this topic (spec §8.1), with the address it opens. */
  nextActivity: NextActivity & { href: string }
  /** The topic's concepts as chips on the header: name, the map's label, whether a wrong idea is on record, and the support band (0 support, 1 core, 2 stretch). Empty for a topic without concepts. */
  concepts: { id: string; name: string; label: ConceptLabel; wrongIdea: boolean; band: Band }[]
  /** The topic's support band (lib/learning/level.ts `topicBand`): where quiz difficulty, the next practice problem and the examples' fading start. */
  topicBand: Band
  /** Which path steps are done (the warm-up taken, the topic read, recall done). */
  pathDone: { warmup: boolean; read: boolean; recall: boolean }
  /** The student has begun the topic: any answer (a warm-up one included), reading, or a step done. The header says "In progress" then. */
  begun: boolean
  /** Recall prompts with an answer, of all of them. The first graded answer counts the topic as recalled; the step is finished at all. */
  recallProgress: { answered: number; total: number }
  /** The steps of the path this topic can offer (no warm-up without a bank, no recall without concepts). */
  pathSteps: PathView[]
  /** Concept extraction is queued or running: Recall shows a preparing state. */
  preparingConcepts: boolean
  /**
   * A topic the student has not started is still being prepared (nothing opened yet, or its concepts and warm-up are being written):
   * it opens on a preparation screen and then on the warm-up, instead of on the reader with a path that changes underneath.
   */
  preparingEntry: boolean
  /** The one-time card about trying before help has not been closed yet. */
  showEffortIntro: boolean
}

const RECENT_ATTEMPTS = 30
const REVIEWED_ATTEMPTS = 10

const toAnswers = (value: unknown): Record<string, string> => {
  const answers: Record<string, string> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, answer] of Object.entries(value as Record<string, unknown>)) {
      if (typeof answer === 'string') answers[key] = answer
    }
  }
  return answers
}

const neighbour = (topic: { id: string; name: string; content: string[] }): TopicNeighbour => ({
  id: topic.id,
  name: topic.name,
  hasNotes: topic.content.includes(CONTENT_TYPE_BY_KIND.notes),
})

export const getTopicPage = cache(async function getTopicPage(
  userId: string,
  courseId: string,
  topicId: string
): Promise<TopicPageData | null> {
  const course = await getCourseShell(userId, courseId)
  const index = course?.topics.findIndex((item) => item.id === topicId) ?? -1
  if (!course || index < 0) return null
  const shellTopic = course.topics[index]
  // On a confirmed list, new topics waiting for review are not part of the course path yet.
  const hidden = course.setup.topics.listConfirmed && !shellTopic.confirmed
  const visible = course.topics.filter((item) => item.id === topicId || !course.setup.topics.listConfirmed || item.confirmed)
  const position = visible.findIndex((item) => item.id === topicId)

  // Concepts that finished after the overview was last opened: convert this topic now, so the path and the explainer gate are right from the first view.
  if (!hidden) await convertTopicIfDue(userId, courseId, topicId, { timeZone: await getTimeZone() }).catch((error) => console.error('Topic conversion failed:', error))

  const [contentRows, quizRows, attemptRows, jobRows, structureRow, sourceRows, practiceRows, learningState, waitingQuizzes, effortIntro] = await Promise.all([
    prisma.topicContent.findMany({
      where: { topicId },
      select: { id: true, contentType: true, contentData: true, metadata: true, updatedAt: true },
    }),
    prisma.topicQuiz.findMany({
      where: { topicId, kind: { in: ['standard', 'retry'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, questions: true, kind: true, createdAt: true },
    }),
    prisma.quizAttempt.findMany({
      where: { topicId, userId },
      orderBy: { takenAt: 'desc' },
      take: RECENT_ATTEMPTS,
      select: { id: true, score: true, takenAt: true, quizSetId: true, answers: true, results: true },
    }),
    prisma.processingJob.findMany({
      where: { userId, jobType: 'generate_content', targetKey: { startsWith: `content:${topicId}:` } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, targetKey: true, status: true, errorCode: true },
    }),
    prisma.topic.findUnique({
      where: { id: topicId },
      select: { objectives: true, prerequisiteIds: true, estimatedMinutes: true, keywords: true },
    }),
    prisma.topicSource.findMany({
      where: { topicId, role: 'primary' },
      orderBy: [{ material: { uploadedAt: 'asc' } }, { materialId: 'asc' }, { chunkIndexStart: 'asc' }],
      select: { materialId: true, pageStart: true, pageEnd: true, material: { select: { filename: true } } },
    }),
    prisma.practiceProgress.findMany({ where: { userId, topicId }, orderBy: { problemIndex: 'asc' } }),
    loadTopicLearningState({ userId, topicId }),
    getWaitingQuizzes(userId, topicId),
    prisma.user.findUnique({ where: { id: userId }, select: { seenEffortIntroAt: true } }),
  ])

  const unit = shellTopic.unitId ? (course.units.find((item) => item.id === shellTopic.unitId) ?? null) : null
  const topicNames = new Map(course.topics.map((item) => [item.id, item.name]))
  const structure: TopicStructure = {
    unit: unit ? { id: unit.id, title: unit.title, weekLabel: unit.weekLabel } : null,
    objectives: structureRow?.objectives ?? [],
    prerequisites: (structureRow?.prerequisiteIds ?? []).flatMap((id) => (topicNames.has(id) ? [{ id, name: topicNames.get(id) as string }] : [])),
    estimatedMinutes: structureRow?.estimatedMinutes ?? null,
    sources: mergeSources(
      sourceRows.map((row) => ({ materialId: row.materialId, filename: row.material.filename, pageStart: row.pageStart, pageEnd: row.pageEnd }))
    ),
  }

  const byType = new Map(contentRows.map((row) => [row.contentType, row]))
  const iso = (date: Date) => date.toISOString()

  const notesRow = byType.get(CONTENT_TYPE_BY_KIND.notes)
  const examplesRow = byType.get(CONTENT_TYPE_BY_KIND.examples)
  const practiceRow = byType.get(CONTENT_TYPE_BY_KIND.practice)
  const quizRow = byType.get(CONTENT_TYPE_BY_KIND.quiz)

  // Quiz sets, newest first. Without any set rows the legacy copy in topic_content is the quiz.
  const storedSets = quizRows
    .map((row) => ({ row, questions: asQuestionList(row.questions) }))
    .filter((item): item is { row: (typeof quizRows)[number]; questions: Record<string, unknown>[] } => !!item.questions)
  const legacyQuestions = asQuestionList(quizRow?.contentData)

  const fullSets = new Map<string, Record<string, unknown>[]>()
  const sets: QuizSetData[] = []
  if (storedSets.length > 0) {
    let standardCount = 0
    storedSets.forEach(({ row, questions }) => {
      fullSets.set(row.id, questions)
      const retry = row.kind === 'retry'
      if (!retry) standardCount += 1
      sets.push({
        id: row.id,
        label: retry ? 'Retry' : `Set ${standardCount}`,
        kind: retry ? 'retry' : 'standard',
        createdAt: iso(row.createdAt),
        questions: toPublicQuestions(questions),
      })
    })
    sets.reverse()
  } else if (legacyQuestions && quizRow) {
    fullSets.set('legacy', legacyQuestions)
    sets.push({
      id: 'legacy',
      label: 'Set 1',
      kind: 'standard',
      createdAt: iso(quizRow.updatedAt),
      questions: toPublicQuestions(legacyQuestions),
    })
  }
  // Attempts on the first quiz have no set id. Once sets exist that quiz is the oldest of them (the content row now holds the newest).
  const firstQuiz = storedSets.length > 0 ? storedSets[0].questions : legacyQuestions
  if (firstQuiz) fullSets.set('legacy', firstQuiz)

  const attempts: QuizAttemptData[] = attemptRows.map((attempt, position) => {
    const setId = attempt.quizSetId ?? 'legacy'
    const questions = fullSets.get(setId)
    return {
      id: attempt.id,
      score: attempt.score,
      takenAt: iso(attempt.takenAt),
      setId,
      answers: toAnswers(attempt.answers),
      review: position < REVIEWED_ATTEMPTS && questions ? buildReview(questions, attempt.results, toAnswers(attempt.answers)) : null,
    }
  })

  const content: TopicPageData['content'] = {
    notes: notesRow ? parseNotes(notesRow.contentData, notesRow.metadata, iso(notesRow.updatedAt)) : null,
    examples: examplesRow ? parseSolvedExamples(examplesRow.contentData, iso(examplesRow.updatedAt)) : null,
    practice: practiceRow ? parsePracticeProblems(practiceRow.contentData, iso(practiceRow.updatedAt)) : null,
    quiz: sets.length > 0 ? { sets, updatedAt: sets[0].createdAt } : null,
  }
  const present: Record<ContentKind, boolean> = {
    notes: !!content.notes,
    examples: !!content.examples,
    practice: !!content.practice,
    quiz: !!content.quiz,
  }

  const failures: TopicPageData['failures'] = {}
  for (const failure of pickGenerationFailures(jobRows, (_topic, contentType) => {
    const kind = KIND_BY_CONTENT_TYPE[contentType]
    return !kind || present[kind]
  })) {
    const kind = KIND_BY_CONTENT_TYPE[failure.contentType]
    if (kind) failures[kind] = { message: failure.message, errorCode: failure.errorCode }
  }

  const due = shellTopic.dueAt ? Date.parse(shellTopic.dueAt) <= Date.now() : false
  const [missed, lastAttemptAt, timeZone] = due
    ? await Promise.all([getMissedQuestions(userId, topicId), getLastAttemptAt(userId, topicId), getTimeZone()])
    : [[], null, null]
  const review: TopicReview = {
    due,
    missedCount: missed.length,
    retryOpensAt: due && timeZone ? (retryOpensAt(lastAttemptAt, timeZone, new Date())?.toISOString() ?? null) : null,
  }

  const hasConcepts = learningState.concepts.length > 0
  const preparingConcepts = !hasConcepts && (await findActiveConceptsJob(topicId)) !== null
  // The same function Home, the overview and the plan use (it also reads whether the AI is up).
  const nextWithHref = await resolveTopicActivity({ userId, courseId, topicId, topics: course.topics, listConfirmed: course.setup.topics.listConfirmed, state: learningState })

  // Not started: no reading, warm-up or evidence yet, and the warm-up is not written. Preparation then runs (or has not been
  // asked for yet, for a topic nobody has opened) and the first step is not known until it settles. A failed job ends the wait.
  const notStarted = !learningState.hasAnyEvidence && learningState.readAt === null && learningState.warmupAt === null && !learningState.warmupReady
  const preparingEntry =
    notStarted &&
    (nextWithHref.kind === 'start' || nextWithHref.kind === 'read') &&
    Object.keys(failures).length === 0 &&
    (nextWithHref.kind === 'start' || preparingConcepts || (await preparationInFlight(topicId)))

  const contentVersion = [
    ...contentRows.map((row) => `${row.contentType}:${row.updatedAt.getTime()}`),
    ...quizRows.map((row) => row.id),
  ]
    .sort()
    .join('|')

  return {
    course: { id: course.id, name: course.name },
    awaitingReview: hidden,
    topic: {
      id: shellTopic.id,
      name: shellTopic.name,
      description: shellTopic.description,
      mastery: shellTopic.mastery,
      earnedMastery: shellTopic.earnedMastery,
      masteryLevel: masteryLevel(shellTopic.mastery),
      dueAt: shellTopic.dueAt,
      daysUntilDue: shellTopic.dueAt ? (Date.parse(shellTopic.dueAt) - Date.now()) / 86_400_000 : null,
      progress: shellTopic.progress,
      structure,
      keywords: structureRow?.keywords ?? [],
    },
    previous: position > 0 ? neighbour(visible[position - 1]) : null,
    next: position < visible.length - 1 ? neighbour(visible[position + 1]) : null,
    content,
    present,
    contentVersion,
    attempts,
    waitingQuizzes,
    review,
    practiceProgress: practiceRows
      .filter((row) => row.contentId === practiceRow?.id && content.practice?.items[row.problemIndex]?.title === row.problemTitle)
      .map((row) => practiceRowProgress(row, content.practice?.items[row.problemIndex]?.steps.length ?? 0)),
    failures,
    nextActivity: nextWithHref,
    pathSteps: pathSteps({ hasConcepts, warmupReady: learningState.warmupReady, warmupDone: learningState.warmupAt !== null, readDone: learningState.readAt !== null, preparingConcepts, preparingEntry }),
    preparingConcepts,
    preparingEntry,
    concepts: learningState.concepts.map((concept) => ({ id: concept.id, name: concept.name ?? '', label: concept.label, wrongIdea: concept.misconception !== null, band: concept.band })),
    topicBand: topicBand(learningState.concepts.map((concept) => ({ band: concept.band, solid: concept.label === 'solid' }))),
    pathDone: { warmup: learningState.warmupAt !== null, read: learningState.readAt !== null, recall: learningState.recallAt !== null },
    // A warm-up answer is not mastery evidence (hasAnyEvidence leaves it out), but it does mean the topic is begun.
    begun:
      learningState.hasAnyEvidence ||
      learningState.readAt !== null ||
      learningState.warmupAt !== null ||
      learningState.recallAt !== null ||
      (await prisma.evidenceEvent.count({ where: { userId, topicId, source: 'warmup' } })) > 0,
    recallProgress: hasConcepts && learningState.recallAt !== null ? await loadRecallProgress(userId, topicId) : { answered: 0, total: 0 },
    showEffortIntro: effortIntro?.seenEffortIntroAt == null,
  }
})
