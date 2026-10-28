import { areRecordIds } from '@/lib/ids'
import { prisma } from '@/lib/db/prisma'
import { gradeExamTarget } from '@/lib/jobs/active-jobs'
import {
  ATTEMPT_IN_PROGRESS,
  ATTEMPT_SUBMITTED,
  loadAttemptState,
  type AttemptView,
} from '@/lib/exams/attempts'
import {
  buildQuestionResults,
  readOverall,
  summarizeTopics,
  type ExamQuestionResult,
  type WeakTopic,
} from '@/lib/exams/results'
import { toPublicQuestions, type PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { examTitle } from '@/lib/exams/display'
import { getExamTitles } from '@/server/queries/exams'
import {
  deriveExamStyleState,
  examProfileTarget,
  materialIdFromProfileTarget,
  type ExamStyleState,
} from '@/lib/exams/style-state'

/** Everything here is filtered by the user id; an id that is not theirs is simply not found. */

/** How many questions each exam has, read in SQL so the question lists are not loaded. */
async function questionCounts(examIds: string[]): Promise<Map<string, number>> {
  if (examIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ id: string; count: number }>>`
    SELECT id, CASE WHEN jsonb_typeof(questions) = 'array' THEN jsonb_array_length(questions) ELSE 0 END::int AS count
    FROM sample_exams
    WHERE id = ANY(${examIds}::text[])
  `
  return new Map(rows.map((row) => [row.id, row.count]))
}

export type ExamListItem = {
  id: string
  title: string
  createdAt: string
  questionCount: number
  durationMinutes: number
  difficulty: string
  /** Best graded score, 0 to 100. */
  bestScore: number | null
  attemptCount: number
  /** An attempt is running and its deadline has not passed. */
  inProgress: boolean
}

export async function listExams(userId: string, courseId: string): Promise<ExamListItem[]> {
  if (!areRecordIds(courseId)) return []
  const exams = await prisma.sampleExam.findMany({
    where: { projectId: courseId, project: { userId } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, createdAt: true, durationMinutes: true, difficultyLevel: true },
  })
  const ids = exams.map((exam) => exam.id)
  const [counts, attempts] = await Promise.all([
    questionCounts(ids),
    prisma.examSubmission.findMany({
      where: { sampleExamId: { in: ids }, userId },
      select: { sampleExamId: true, status: true, deadlineAt: true, aiGrading: true },
    }),
  ])
  const now = Date.now()
  const titles = await getExamTitles(userId, courseId)

  return exams.map((exam) => {
    const mine = attempts.filter((attempt) => attempt.sampleExamId === exam.id)
    const submitted = mine.filter((attempt) => attempt.status === ATTEMPT_SUBMITTED)
    const scores = submitted
      .map((attempt) => readOverall(attempt.aiGrading)?.score)
      .filter((score): score is number => typeof score === 'number')
    return {
      id: exam.id,
      title: titles.get(exam.id) ?? examTitle(exam.name, exam.createdAt),
      createdAt: exam.createdAt.toISOString(),
      questionCount: counts.get(exam.id) ?? 0,
      durationMinutes: exam.durationMinutes,
      difficulty: exam.difficultyLevel,
      bestScore: scores.length > 0 ? Math.max(...scores) : null,
      attemptCount: submitted.length,
      inProgress: mine.some(
        (attempt) => attempt.status === ATTEMPT_IN_PROGRESS && !!attempt.deadlineAt && attempt.deadlineAt.getTime() > now
      ),
    }
  })
}

export type AttemptRow = {
  id: string
  submittedAt: string
  state: 'graded' | 'grading' | 'failed'
  /** 0 to 100, when graded. */
  score: number | null
}

export type ExamLobby = {
  id: string
  courseId: string
  title: string
  createdAt: string
  questionCount: number
  durationMinutes: number
  difficulty: string
  topics: string[]
  attempts: AttemptRow[]
  /** The attempt to resume, with the server's clock for the countdown. */
  inProgress: { deadlineAt: string; serverNow: string; remainingSeconds: number } | null
}

export async function getExamLobby(userId: string, courseId: string, examId: string): Promise<ExamLobby | null> {
  if (!areRecordIds(courseId, examId)) return null
  const exam = await prisma.sampleExam.findFirst({
    where: { id: examId, projectId: courseId, project: { userId } },
    select: {
      id: true,
      name: true,
      createdAt: true,
      durationMinutes: true,
      difficultyLevel: true,
      topicsCovered: true,
      projectId: true,
    },
  })
  if (!exam) return null

  // An attempt whose time ran out while the student was away is submitted here, as saved.
  const state = await loadAttemptState(userId, { id: exam.id, projectId: exam.projectId, durationMinutes: exam.durationMinutes })

  const [counts, submissions] = await Promise.all([
    questionCounts([exam.id]),
    prisma.examSubmission.findMany({
      where: { sampleExamId: exam.id, userId, status: ATTEMPT_SUBMITTED },
      orderBy: { submittedAt: 'desc' },
      select: { id: true, submittedAt: true, aiGrading: true },
    }),
  ])

  const ungraded = submissions.filter((submission) => !readOverall(submission.aiGrading))
  const jobs = ungraded.length
    ? await prisma.processingJob.findMany({
        where: { userId, jobType: 'grade_exam', targetKey: { in: ungraded.map((s) => gradeExamTarget(s.id)) } },
        orderBy: { createdAt: 'desc' },
        select: { targetKey: true, status: true },
      })
    : []
  const latestJob = new Map<string, string>()
  for (const job of jobs) if (job.targetKey && !latestJob.has(job.targetKey)) latestJob.set(job.targetKey, job.status)

  const attempts: AttemptRow[] = submissions.map((submission) => {
    const overall = readOverall(submission.aiGrading)
    if (overall) return { id: submission.id, submittedAt: submission.submittedAt.toISOString(), state: 'graded', score: overall.score }
    const status = latestJob.get(gradeExamTarget(submission.id))
    const running = status === 'pending' || status === 'processing'
    return { id: submission.id, submittedAt: submission.submittedAt.toISOString(), state: running ? 'grading' : 'failed', score: null }
  })

  const active = state.kind === 'active' ? state.attempt : null
  const titles = await getExamTitles(userId, courseId)
  return {
    id: exam.id,
    courseId: exam.projectId,
    title: titles.get(exam.id) ?? examTitle(exam.name, exam.createdAt),
    createdAt: exam.createdAt.toISOString(),
    questionCount: counts.get(exam.id) ?? 0,
    durationMinutes: exam.durationMinutes,
    difficulty: exam.difficultyLevel,
    topics: exam.topicsCovered,
    attempts,
    inProgress: active
      ? { deadlineAt: active.deadlineAt, serverNow: active.serverNow, remainingSeconds: active.remainingSeconds }
      : null,
  }
}

export type ExamForTaking = {
  id: string
  courseId: string
  title: string
  durationMinutes: number
  questions: PublicQuizQuestion[]
}

export type TakeState =
  | { kind: 'missing' }
  /** No attempt is running: send the student to the lobby. */
  | { kind: 'none' }
  /** The deadline passed while they were away: it was submitted as saved. */
  | { kind: 'finalized'; submissionId: string }
  | { kind: 'active'; exam: ExamForTaking; attempt: AttemptView }

/** What the taking page needs: the questions without their answer key, and the running attempt. */
export async function getTakeState(userId: string, courseId: string, examId: string): Promise<TakeState> {
  if (!areRecordIds(courseId, examId)) return { kind: 'missing' }
  const exam = await prisma.sampleExam.findFirst({
    where: { id: examId, projectId: courseId, project: { userId } },
    select: { id: true, name: true, createdAt: true, durationMinutes: true, questions: true, projectId: true },
  })
  if (!exam) return { kind: 'missing' }

  const state = await loadAttemptState(userId, { id: exam.id, projectId: exam.projectId, durationMinutes: exam.durationMinutes })
  if (state.kind === 'none') return { kind: 'none' }
  if (state.kind === 'finalized') return { kind: 'finalized', submissionId: state.submissionId }
  const titles = await getExamTitles(userId, courseId)
  return {
    kind: 'active',
    attempt: state.attempt,
    exam: {
      id: exam.id,
      courseId: exam.projectId,
      title: titles.get(exam.id) ?? examTitle(exam.name, exam.createdAt),
      durationMinutes: exam.durationMinutes,
      questions: toPublicQuestions(exam.questions),
    },
  }
}

export type ResultTopic = WeakTopic & { linkable: boolean }

type ResultBase = {
  id: string
  examId: string
  courseId: string
  examTitle: string
  submittedAt: string
}

export type ExamResult =
  | (ResultBase & {
      status: 'grading' | 'failed'
      /** The grading job to follow, when there is one. */
      jobId: string | null
      errorCode: string | null
      errorMessage: string | null
    })
  | (ResultBase & {
      status: 'graded'
      score: number
      earnedPoints: number
      totalPoints: number
      needsReviewCount: number
      questions: ExamQuestionResult[]
      topics: ResultTopic[]
      /** A second grading of this attempt is running (the student asked for one): the job to follow. */
      regradeJobId: string | null
    })

/**
 * One submission's results. This is where the exam's answer key is released, so it only does
 * so for a submitted, graded submission the user owns.
 */
export async function getExamResult(
  userId: string,
  courseId: string,
  examId: string,
  submissionId: string
): Promise<ExamResult | null> {
  if (!areRecordIds(courseId, examId, submissionId)) return null
  const submission = await prisma.examSubmission.findFirst({
    where: {
      id: submissionId,
      sampleExamId: examId,
      userId,
      status: ATTEMPT_SUBMITTED,
      sampleExam: { projectId: courseId },
    },
    include: { sampleExam: { select: { name: true, createdAt: true, projectId: true, questions: true } } },
  })
  if (!submission) return null

  const titles = await getExamTitles(userId, courseId)
  const base: ResultBase = {
    id: submission.id,
    examId,
    courseId: submission.sampleExam.projectId,
    examTitle: titles.get(examId) ?? examTitle(submission.sampleExam.name, submission.sampleExam.createdAt),
    submittedAt: submission.submittedAt.toISOString(),
  }

  const overall = readOverall(submission.aiGrading)
  if (!overall) {
    const job = await prisma.processingJob.findFirst({
      where: { userId, jobType: 'grade_exam', targetKey: gradeExamTarget(submission.id) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, errorCode: true, errorMessage: true },
    })
    const running = job?.status === 'pending' || job?.status === 'processing'
    return {
      ...base,
      status: running ? 'grading' : 'failed',
      jobId: running ? (job?.id ?? null) : null,
      errorCode: job?.errorCode ?? null,
      errorMessage: job?.errorMessage ?? null,
    }
  }

  const questions = buildQuestionResults(submission.sampleExam.questions, submission.aiGrading, submission.answers)

  // Link a topic only while it still exists (topics can be merged or deleted).
  const topicIds = [...new Set(questions.map((q) => q.topicId).filter((id): id is string => !!id))]
  const existing = topicIds.length
    ? await prisma.topic.findMany({
        where: { id: { in: topicIds }, projectId: submission.sampleExam.projectId },
        select: { id: true, name: true },
      })
    : []
  const currentNames = new Map(existing.map((topic) => [topic.id, topic.name]))
  const topics: ResultTopic[] = summarizeTopics(questions).map((topic) => ({
    ...topic,
    topicName: (topic.topicId && currentNames.get(topic.topicId)) || topic.topicName,
    linkable: !!topic.topicId && currentNames.has(topic.topicId),
  }))

  const regrading = await prisma.processingJob.findFirst({
    where: {
      userId,
      jobType: 'grade_exam',
      targetKey: gradeExamTarget(submission.id),
      status: { in: ['pending', 'processing'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  return {
    ...base,
    status: 'graded',
    regradeJobId: regrading?.id ?? null,
    score: overall.score,
    earnedPoints: overall.earned,
    totalPoints: overall.total,
    needsReviewCount: questions.filter((q) => q.needsReview).length,
    questions,
    topics,
  }
}

/** An exam still being written for this course (found after a refresh), or null. */
export async function findActiveExamJob(
  userId: string,
  courseId: string
): Promise<{ id: string; startedAt: string } | null> {
  if (!areRecordIds(courseId)) return null
  const job = await prisma.processingJob.findFirst({
    where: { userId, projectId: courseId, jobType: 'generate_exam', status: { in: ['pending', 'processing'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  })
  return job ? { id: job.id, startedAt: job.createdAt.toISOString() } : null
}

/**
 * Whether "Match my past exams" has a style to match, and if not, why (see lib/exams/style-state):
 * from the course's past-exam files and the latest profile_exam job of each.
 */
export async function getExamStyleState(userId: string, courseId: string): Promise<ExamStyleState> {
  if (!areRecordIds(courseId)) return deriveExamStyleState([], [])
  const files = await prisma.material.findMany({
    where: { role: 'exam', project: { id: courseId, userId } },
    select: { id: true, validationStatus: true, styleProfile: true },
  })
  if (files.length === 0) return deriveExamStyleState([], [])
  const jobs = await prisma.processingJob.findMany({
    where: { userId, projectId: courseId, jobType: 'profile_exam', targetKey: { in: files.map((f) => examProfileTarget(f.id)) } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { targetKey: true, status: true, errorCode: true },
  })
  return deriveExamStyleState(
    files.map((file) => ({
      id: file.id,
      validationStatus: file.validationStatus,
      hasProfile: file.validationStatus === 'valid' && file.styleProfile !== null,
    })),
    jobs.flatMap((job) => {
      const materialId = materialIdFromProfileTarget(job.targetKey)
      return materialId ? [{ materialId, status: job.status, errorCode: job.errorCode }] : []
    })
  )
}
