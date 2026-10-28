import { notFound } from 'next/navigation'
import { areRecordIds } from '@/lib/ids'
import { prisma } from '@/lib/db/prisma'
import { examTitle } from '@/lib/exams/display'
import { dueBoundary, isReviewDue, nextStepForCourse, type DueTopic, type NextStep } from '@/lib/learning/next-step'
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs/active-jobs'
import { typicalPipelineSeconds } from '@/lib/jobs/estimate'
import {
  contentTypeLabel,
  describeJobFailure,
  pickGenerationFailures,
  type GenerationJobRow,
} from '@/lib/jobs/failure-message'
import { maxUploadMb } from '@/lib/storage/upload-limits'
import { courseMastery, masteryLevel, countMasteryLevels, type MasteryCounts } from '@/lib/mastery'
import { readRole, type MaterialRole } from '@/lib/materials/role'
import { parsePracticeProblems } from '@/features/topic/content'
import { mergeSources, type SourceRef } from '@/lib/topics/sources'
import { PRACTICE_DONE_SHARE } from '@/features/topic/practice-keys'
import { getCourseShell, type CourseShell, type ShellTopic, type ShellUnit } from '@/server/queries/courses'
import { getPlanData } from '@/server/queries/plan'
import { deriveExamStyleState, examProfileTarget, materialIdFromProfileTarget } from '@/lib/exams/style-state'

/**
 * Read models for the course pages: overview (setup guide and Today view), materials and
 * topics. Everything is filtered by the user id; an id that is not theirs is not found.
 */

export const CORE_CONTENT_TYPES = ['section_notes', 'solved_examples', 'interactive_examples', 'topic_quiz'] as const

const STALE_JOB_WINDOW_MS = 6 * 60 * 1000
const PENDING_DISPATCH_STALE_MS = 90 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** A running job, as the browser needs it to follow it. */
export type JobRef = {
  id: string
  stage: string | null
  progressPercent: number
  createdAt: string
}

type JobRow = {
  id: string
  stage: string | null
  progressPercent: number
  createdAt: Date
}

const toJobRef = (job: JobRow): JobRef => ({
  id: job.id,
  stage: job.stage,
  progressPercent: job.progressPercent,
  createdAt: job.createdAt.toISOString(),
})

// ---------------------------------------------------------------------------------------
// Materials

export type MaterialStatus = 'processing' | 'ready' | 'unusable' | 'failed'

export type MaterialRow = {
  id: string
  filename: string
  category: string
  /** What the file is for: content, syllabus, exam (past exam) or other. Editable (PATCH /api/materials/[id]). */
  role: MaterialRole
  sizeBytes: number
  status: MaterialStatus
  /** The reason a file is not usable (validationNotes). */
  notes: string | null
  uploadedAt: string
  /** The validate or chunk job to follow while the file is being processed. */
  job: (JobRef & { jobType: string }) | null
  /** A past exam whose style analysis failed: the job's error code (null when it did not fail). */
  examAnalysisFailure: { errorCode: string | null } | null
}

export type MaterialsData = {
  maxUploadMb: number
  materials: MaterialRow[]
  readyCount: number
  processingCount: number
  /** A topic-finding job that is running now. */
  extractJob: JobRef | null
  /** The latest topic-finding job failed and there are no topics to show for it. */
  extractFailure: string | null
  /**
   * How long a file usually takes from upload to read, in seconds: the median of recently finished
   * jobs (all courses, durations only), or null while there are too few of them to say.
   */
  typicalReadSeconds: number | null
}

const ESTIMATE_WINDOW_DAYS = 45

/** Durations of recently finished file jobs, for the "usually about" line. Only times, nothing about whose they are. */
async function typicalReadSeconds(): Promise<number | null> {
  const since = new Date(Date.now() - ESTIMATE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const finished = await prisma.processingJob.findMany({
    where: { jobType: { in: ['validate_material', 'chunk_material'] }, status: 'completed', completedAt: { gte: since } },
    orderBy: { completedAt: 'desc' },
    take: 80,
    select: { jobType: true, createdAt: true, completedAt: true },
  })
  const durations = (type: string) =>
    finished
      .filter((job) => job.jobType === type && job.completedAt)
      .map((job) => (job.completedAt as Date).getTime() - job.createdAt.getTime())
  return typicalPipelineSeconds([durations('validate_material'), durations('chunk_material')])
}

export async function getMaterialsData(userId: string, courseId: string): Promise<MaterialsData> {
  // The materials page checks the course first, but runs this at the same time: an unusable id is a 404 either way.
  if (!areRecordIds(courseId)) notFound()
  const [materials, pipelineJobs, extractJobs, topicCount, typicalSeconds] = await Promise.all([
    prisma.material.findMany({
      where: { projectId: courseId, project: { userId } },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        filename: true,
        category: true,
        role: true,
        sizeBytes: true,
        validationStatus: true,
        validationNotes: true,
        uploadedAt: true,
        styleProfile: true,
      },
    }),
    prisma.processingJob.findMany({
      where: { projectId: courseId, userId, jobType: { in: ['validate_material', 'chunk_material'] } },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: {
        id: true,
        jobType: true,
        status: true,
        stage: true,
        progressPercent: true,
        createdAt: true,
        inputData: true,
      },
    }),
    prisma.processingJob.findMany({
      where: { projectId: courseId, userId, jobType: 'extract_topics' },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, status: true, stage: true, progressPercent: true, createdAt: true, errorCode: true, errorMessage: true },
    }),
    prisma.topic.count({ where: { projectId: courseId, project: { userId } } }),
    typicalReadSeconds(),
  ])

  // Past exams: the latest style analysis of each, so a failed one shows on its row with a retry.
  const examIds = materials.filter((material) => material.role === 'exam').map((material) => material.id)
  const profileJobs = examIds.length
    ? await prisma.processingJob.findMany({
        where: { projectId: courseId, userId, jobType: 'profile_exam', targetKey: { in: examIds.map(examProfileTarget) } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { targetKey: true, status: true, errorCode: true },
      })
    : []
  const examState = deriveExamStyleState(
    materials
      .filter((material) => material.role === 'exam')
      .map((material) => ({
        id: material.id,
        validationStatus: material.validationStatus,
        hasProfile: material.styleProfile !== null,
      })),
    profileJobs.flatMap((job) => {
      const materialId = materialIdFromProfileTarget(job.targetKey)
      return materialId ? [{ materialId, status: job.status, errorCode: job.errorCode }] : []
    })
  )
  const examFailureCode = new Map<string, string | null>()
  for (const job of profileJobs) {
    const materialId = materialIdFromProfileTarget(job.targetKey)
    if (materialId && !examFailureCode.has(materialId)) examFailureCode.set(materialId, job.errorCode)
  }

  const jobsByMaterial = new Map<string, typeof pipelineJobs>()
  for (const job of pipelineJobs) {
    const materialId = isRecord(job.inputData) && typeof job.inputData.materialId === 'string' ? job.inputData.materialId : null
    if (!materialId) continue
    const list = jobsByMaterial.get(materialId)
    if (list) list.push(job)
    else jobsByMaterial.set(materialId, [job])
  }

  const rows: MaterialRow[] = materials.map((material) => {
    const jobs = jobsByMaterial.get(material.id) ?? []
    // Newest first, so the first active job is the one in front.
    const active = jobs.find((job) => ACTIVE_JOB_STATUSES.includes(job.status))
    const latest = jobs[0]
    let status: MaterialStatus
    if (material.validationStatus === 'invalid') status = 'unusable'
    else if (active) status = 'processing'
    else if (material.validationStatus === 'pending') status = latest?.status === 'completed' ? 'processing' : 'failed'
    else status = latest?.status === 'failed' ? 'failed' : 'ready'

    return {
      id: material.id,
      filename: material.filename,
      category: material.category,
      role: readRole(material.role),
      sizeBytes: Number(material.sizeBytes),
      status,
      notes: material.validationNotes,
      uploadedAt: material.uploadedAt.toISOString(),
      job: active ? { ...toJobRef(active), jobType: active.jobType } : null,
      examAnalysisFailure: examState.failedFileIds.includes(material.id)
        ? { errorCode: examFailureCode.get(material.id) ?? null }
        : null,
    }
  })

  const activeExtract = extractJobs.find((job) => ACTIVE_JOB_STATUSES.includes(job.status))
  const latestExtract = extractJobs[0]
  return {
    maxUploadMb: maxUploadMb(),
    materials: rows,
    readyCount: rows.filter((row) => row.status === 'ready').length,
    processingCount: rows.filter((row) => row.status === 'processing').length,
    extractJob: activeExtract ? toJobRef(activeExtract) : null,
    extractFailure:
      !activeExtract && topicCount === 0 && latestExtract?.status === 'failed'
        ? describeJobFailure(latestExtract.errorCode, latestExtract.errorMessage, 'extract_topics')
        : null,
    typicalReadSeconds: typicalSeconds,
  }
}

// ---------------------------------------------------------------------------------------
// Content generation

export type GenerationFailureRow = {
  jobId: string
  topicId: string
  topicName: string
  contentType: string
  /** "Notes for Hashing couldn't be written. The AI service was busy." */
  message: string
}

export type GenerationState = {
  /**
   * The four core content types for each topic content is being written for: every confirmed
   * topic during "Prepare all topics now", otherwise the topics that have some content, a job
   * running or a failure (content is written as topics are opened, not for the whole course).
   */
  totalBlocks: number
  /** Blocks that exist. */
  readyBlocks: number
  /** Generation jobs running now (stale ones left out, as in the planner). */
  activeJobs: number
  failures: GenerationFailureRow[]
}

const BLOCK_NOUN: Record<string, string> = {
  section_notes: 'Notes',
  solved_examples: 'Worked examples',
  interactive_examples: 'Practice',
  topic_quiz: 'The quiz',
}

export const blockNoun = (contentType: string): string => BLOCK_NOUN[contentType] ?? contentTypeLabel(contentType)

export async function getGenerationState(userId: string, course: CourseShell): Promise<GenerationState> {
  const confirmed = course.topics.filter((topic) => topic.confirmed)
  const core = new Set<string>(CORE_CONTENT_TYPES)

  const staleBefore = new Date(Date.now() - STALE_JOB_WINDOW_MS)
  const pendingBefore = new Date(Date.now() - PENDING_DISPATCH_STALE_MS)

  const [activeJobs, recent] = await Promise.all([
    prisma.processingJob.findMany({
      where: { projectId: course.id, userId, jobType: 'generate_content', status: { in: ACTIVE_JOB_STATUSES } },
      select: { status: true, createdAt: true, startedAt: true, inputData: true },
    }),
    prisma.processingJob.findMany({
      where: { projectId: course.id, userId, jobType: 'generate_content', targetKey: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 600,
      select: { id: true, targetKey: true, status: true, errorCode: true, errorMessage: true },
    }),
  ])

  const liveJobs = activeJobs.filter(
    (job) => !(job.createdAt < staleBefore || (job.status === 'pending' && !job.startedAt && job.createdAt < pendingBefore))
  )
  const active = liveJobs.length

  const topicsById = new Map(course.topics.map((topic) => [topic.id, topic]))
  const failures = pickGenerationFailures(recent as GenerationJobRow[], (topicId, contentType) =>
    topicsById.get(topicId)?.content.includes(contentType) ?? false
  )
    .filter((failure) => topicsById.has(failure.topicId))
    .map((failure) => {
      const topicName = topicsById.get(failure.topicId)!.name
      return {
        jobId: failure.jobId,
        topicId: failure.topicId,
        topicName,
        contentType: failure.contentType,
        message: `${blockNoun(failure.contentType)} for ${topicName} couldn't be written. ${failure.message}`,
      }
    })


  const preparingAll = liveJobs.some(
    (job) => isRecord(job.inputData) && isRecord(job.inputData.preferences) && job.inputData.preferences.prepare_all === true
  )
  const inPlay = new Set(liveJobs.flatMap((job) => (isRecord(job.inputData) && typeof job.inputData.topicId === 'string' ? [job.inputData.topicId] : [])))
  for (const failure of failures) inPlay.add(failure.topicId)
  const counted = confirmed.filter(
    (topic) => preparingAll || inPlay.has(topic.id) || topic.content.some((type) => core.has(type))
  )
  const readyBlocks = counted.reduce((sum, topic) => sum + topic.content.filter((type) => core.has(type)).length, 0)
  return { totalBlocks: counted.length * CORE_CONTENT_TYPES.length, readyBlocks, activeJobs: active, failures }
}

// ---------------------------------------------------------------------------------------
// Overview

export type RecentExam = {
  submissionId: string
  examId: string
  name: string
  submittedAt: string
  /** 0 to 100, or null while it is still being graded. */
  score: number | null
}

export type TodayTopic = {
  id: string
  name: string
  mastery: number | null
  dueAt: string | null
  /** The review is due by the end of the student's today. */
  due: boolean
}

export type TodayData = {
  topicCount: number
  counts: MasteryCounts
  /** Course mastery (0..1): mean over all topics, not-started ones counting as 0. Null with no topics. */
  averageMastery: number | null
  tiles: TodayTopic[]
  /** What to do next: the one function the home page, this card and the sidebar share. */
  next: NextStep
  /** Ask "When is your exam?": no date yet and the card was not dismissed. */
  examPrompt: boolean
  recentExams: RecentExam[]
  generation: GenerationState
  /** Confirmed topics with some content not written yet, for "Prepare all topics now". */
  topicsToPrepare: number
}

export type SetupData = {
  /** The step to show as current: 1 add, 2 check, 3 build. */
  step: 1 | 2 | 3
  materials: MaterialsData
  topicCount: number
  confirmedTopicCount: number
  /** The first confirmed topic in course order, where "Start studying" goes. */
  firstTopic: { id: string; name: string } | null
  generation: GenerationState
}

export type CourseOverview =
  | { mode: 'today'; course: CourseShell; today: TodayData }
  | { mode: 'setup'; course: CourseShell; setup: SetupData }

export function summarizeTopics(topics: ShellTopic[]) {
  const confirmed = topics.filter((topic) => topic.confirmed)
  const levels = confirmed.map((topic) => masteryLevel(topic.mastery))
  return {
    topicCount: confirmed.length,
    counts: countMasteryLevels(levels),
    averageMastery: courseMastery(confirmed.map((topic) => topic.mastery)),
  }
}

/** The confirmed topics whose review is due by the end of the student's today (see lib/learning/next-step.ts). */
export function dueTopicsOf(topics: ShellTopic[], now: Date, timeZone: string): DueTopic[] {
  const boundary = dueBoundary(now, timeZone)
  return topics
    .filter((topic) => topic.confirmed && isReviewDue(topic.dueAt, boundary))
    .map((topic) => ({ topicId: topic.id, name: topic.name, dueAt: topic.dueAt as string, mastery: topic.mastery }))
}

/** Due topics first (most overdue first), the rest in course order. */
function dueFirst<T extends { due: boolean; dueAt: string | null }>(topics: T[]): T[] {
  const due = topics.filter((topic) => topic.due).sort((a, b) => Date.parse(a.dueAt as string) - Date.parse(b.dueAt as string))
  return [...due, ...topics.filter((topic) => !topic.due)]
}

/** The Today view or the setup guide for a course, with everything either needs. Null if not theirs. */
export async function getCourseOverview(
  userId: string,
  courseId: string,
  timeZone: string
): Promise<CourseOverview | null> {
  const course = await getCourseShell(userId, courseId)
  if (!course) return null

  if (course.setup.mode === 'setup') {
    const [materials, generation] = await Promise.all([getMaterialsData(userId, courseId), getGenerationState(userId, course)])
    const confirmedTopicCount = course.topics.filter((topic) => topic.confirmed).length
    // The files step stays open while no file is usable yet or one is still being read, unless
    // topic finding has already started.
    const filesDone =
      materials.readyCount > 0 && (materials.processingCount === 0 || !!materials.extractJob || course.topics.length > 0)
    const step = course.setup.step === 2 && !filesDone ? 1 : course.setup.step
    return {
      mode: 'setup',
      course,
      setup: {
        step,
        materials,
        topicCount: course.topics.length,
        confirmedTopicCount,
        firstTopic: course.topics.find((topic) => topic.confirmed) ?? null,
        generation,
      },
    }
  }

  const [planData, generation, submissions] = await Promise.all([
    getPlanData(userId, courseId, timeZone),
    getGenerationState(userId, course),
    prisma.examSubmission.findMany({
      where: { userId, status: 'submitted', sampleExam: { projectId: courseId, project: { userId } } },
      orderBy: { submittedAt: 'desc' },
      take: 3,
      select: {
        id: true,
        submittedAt: true,
        aiGrading: true,
        sampleExam: { select: { id: true, name: true, createdAt: true } },
      },
    }),
  ])

  if (!planData) return null
  const { plan } = planData

  const now = new Date()
  const summary = summarizeTopics(course.topics)
  const boundary = dueBoundary(now, timeZone)
  const next = nextStepForCourse({
    courseId,
    setup: course.setup,
    plan,
    due: dueTopicsOf(course.topics, now, timeZone),
    now,
    timeZone,
  })
  return {
    mode: 'today',
    course,
    today: {
      ...summary,
      tiles: dueFirst(
        course.topics
          .filter((topic) => topic.confirmed)
          .map((topic) => ({ id: topic.id, name: topic.name, mastery: topic.mastery, dueAt: topic.dueAt, due: isReviewDue(topic.dueAt, boundary) }))
      ).slice(0, 8),
      next,
      examPrompt: course.examDate === null && !course.examPromptDismissed,
      generation,
      topicsToPrepare: course.topics.filter(
        (topic) => topic.confirmed && CORE_CONTENT_TYPES.some((type) => !topic.content.includes(type))
      ).length,
      recentExams: submissions.map((submission) => ({
        submissionId: submission.id,
        examId: submission.sampleExam.id,
        name: examTitle(submission.sampleExam.name, submission.sampleExam.createdAt),
        submittedAt: submission.submittedAt.toISOString(),
        score:
          isRecord(submission.aiGrading) && typeof submission.aiGrading.overall_score === 'number'
            ? submission.aiGrading.overall_score
            : null,
      })),
    },
  }
}

// ---------------------------------------------------------------------------------------
// Topics

export type TopicRow = {
  id: string
  name: string
  description: string | null
  keywords: string[]
  orderIndex: number
  /** The unit it belongs to, or null (a flat course, or a topic added by hand). */
  unitId: string | null
  /** What the student can do after the topic: verb phrases that finish "By the end you can ...". */
  objectives: string[]
  /** Topics (ids, same course, earlier in the order) this one builds on. */
  prerequisiteIds: string[]
  estimatedMinutes: number | null
  /** The topic's concepts appear on the student's past exams. */
  examRelevant: boolean
  /** What the topic is taught from, one entry per file and page range, in document order. Empty for topics added by hand. */
  sources: SourceRef[]
  confirmed: boolean
  mastery: number | null
  dueAt: string | null
  lastReviewedAt: string | null
  progress: { notes: boolean; examples: boolean; quiz: boolean; quizScore: number | null }
  /** At least 80% of the practice steps are solved (stored on the server). */
  practiceDone: boolean
  content: string[]
}

export type TopicsData = {
  courseName: string
  /** In course order; empty for a flat course. */
  units: ShellUnit[]
  topics: TopicRow[]
  /** At least one topic is not confirmed yet. */
  hasUnconfirmed: boolean
  materialsReady: number
  materialsProcessing: number
  extractJob: JobRef | null
  extractFailure: string | null
  generation: GenerationState
}

export async function getTopicsData(userId: string, courseId: string): Promise<TopicsData | null> {
  const course = await getCourseShell(userId, courseId)
  if (!course) return null

  const [extra, sourceRows, materials, generation, practiceRows, practiceContent] = await Promise.all([
    prisma.topic.findMany({
      where: { projectId: courseId, project: { userId } },
      select: {
        id: true,
        keywords: true,
        objectives: true,
        prerequisiteIds: true,
        estimatedMinutes: true,
        examRelevant: true,
        reviewSchedules: { where: { userId }, take: 1, select: { lastReviewedAt: true } },
      },
    }),
    prisma.topicSource.findMany({
      where: { role: 'primary', topic: { projectId: courseId, project: { userId } } },
      orderBy: [{ material: { uploadedAt: 'asc' } }, { materialId: 'asc' }, { chunkIndexStart: 'asc' }],
      select: { topicId: true, materialId: true, pageStart: true, pageEnd: true, material: { select: { filename: true } } },
    }),
    getMaterialsData(userId, courseId),
    getGenerationState(userId, course),
    prisma.practiceProgress.findMany({
      where: { userId, topic: { projectId: courseId } },
      select: { topicId: true, contentId: true, problemIndex: true, problemTitle: true, stepsSolved: true },
    }),
    prisma.topicContent.findMany({
      where: { contentType: 'interactive_examples', topic: { projectId: courseId, project: { userId } } },
      select: { id: true, topicId: true, contentData: true, updatedAt: true },
    }),
  ])
  // Practice is done when 80% of the steps of the current problems are solved.
  const practiceDone = new Set<string>()
  for (const content of practiceContent) {
    const problems = parsePracticeProblems(content.contentData, content.updatedAt.toISOString())?.items ?? []
    const total = problems.reduce((sum, problem) => sum + problem.steps.length, 0)
    const solved = practiceRows
      .filter((row) => row.contentId === content.id && problems[row.problemIndex]?.title === row.problemTitle)
      .reduce((sum, row) => sum + row.stepsSolved, 0)
    if (total > 0 && solved / total >= PRACTICE_DONE_SHARE) practiceDone.add(content.topicId)
  }
  const extraById = new Map(extra.map((row) => [row.id, row]))
  const sourcesByTopic = new Map<string, SourceRef[]>()
  for (const row of sourceRows) {
    const list = sourcesByTopic.get(row.topicId) ?? []
    list.push({ materialId: row.materialId, filename: row.material.filename, pageStart: row.pageStart, pageEnd: row.pageEnd })
    sourcesByTopic.set(row.topicId, list)
  }

  const topics: TopicRow[] = course.topics.map((topic) => ({
    id: topic.id,
    name: topic.name,
    description: topic.description,
    keywords: extraById.get(topic.id)?.keywords ?? [],
    orderIndex: topic.orderIndex,
    unitId: topic.unitId,
    objectives: extraById.get(topic.id)?.objectives ?? [],
    prerequisiteIds: extraById.get(topic.id)?.prerequisiteIds ?? [],
    estimatedMinutes: extraById.get(topic.id)?.estimatedMinutes ?? null,
    examRelevant: extraById.get(topic.id)?.examRelevant ?? false,
    sources: mergeSources(sourcesByTopic.get(topic.id) ?? []),
    confirmed: topic.confirmed,
    mastery: topic.mastery,
    dueAt: topic.dueAt,
    lastReviewedAt: extraById.get(topic.id)?.reviewSchedules[0]?.lastReviewedAt?.toISOString() ?? null,
    progress: topic.progress,
    practiceDone: practiceDone.has(topic.id),
    content: topic.content,
  }))

  return {
    courseName: course.name,
    units: course.units,
    topics,
    hasUnconfirmed: topics.some((topic) => !topic.confirmed),
    materialsReady: materials.readyCount,
    materialsProcessing: materials.processingCount,
    extractJob: materials.extractJob,
    extractFailure: materials.extractFailure,
    generation,
  }
}
