import { logServerError } from '@/lib/ops/log'
import { prisma } from '@/lib/db/prisma'
import { recordExamEvidence } from './exam-evidence'
import { computeTopicMastery, upsertReviewSchedule } from './mastery'
import { studentTimeZone } from './student-time-zone'
import { dueForEvidenceRetry, logIfGivenUp } from './evidence-retry-budget'

/** How many owed evidence writes one visit tries again. */
const RETRY_LIMIT = 5

/**
 * Writes the concept evidence of one graded submission and marks it written. A failure leaves
 * `evidenceRecordedAt` unset, so the next visit tries again (applyPendingExamResults); the write
 * replaces the submission's own session, so trying again is safe.
 */
async function recordSubmissionEvidence(userId: string, projectId: string, submissionId: string): Promise<boolean> {
  // Reading the submission is part of the try: a failure there is a failed try like any other.
  let written = false
  try {
    const submission = await prisma.examSubmission.findFirst({
      where: { id: submissionId, userId },
      select: { answers: true, aiGrading: true, submittedAt: true, sampleExam: { select: { id: true, questions: true } } },
    })
    if (!submission) return true
    written = Array.isArray(submission.sampleExam.questions)
      ? await recordExamEvidence({
          userId,
          projectId,
          examId: submission.sampleExam.id,
          submissionId,
          questions: submission.sampleExam.questions as Record<string, unknown>[],
          answers: submission.answers,
          aiGrading: submission.aiGrading,
          at: submission.submittedAt,
          timeZone: await studentTimeZone(),
        })
      : true
  } catch (error) {
    logServerError('Reading an exam submission for its evidence failed', error)
  }
  // Marking has its own guard: the evidence is written, and a failure here must not undo the schedules
  // (the caller puts reviewAppliedAt back on an error, which would apply them again).
  try {
    if (written) {
      await prisma.examSubmission.updateMany({ where: { id: submissionId, userId }, data: { evidenceRecordedAt: new Date() } })
    } else {
      const updated = await prisma.examSubmission.update({
        where: { id: submissionId },
        data: { evidenceAttempts: { increment: 1 }, evidenceTriedAt: new Date() },
        select: { evidenceAttempts: true },
      })
      logIfGivenUp('exam', submissionId, updated.evidenceAttempts)
    }
  } catch (error) {
    logServerError('Marking exam evidence failed', error)
  }
  return written
}

/** An exam is "right" for a topic, for scheduling the next review, at this share of its points. */
export const EXAM_PASS_SHARE = 0.7

/**
 * Per-topic scores of one graded submission, from the exam learning signals the grading job stored
 * (one per question, with the topic of the question). Topic id to the mean of its questions.
 */
export function scoresByTopic(signals: { topicId: string | null; score: number }[]): Map<string, number> {
  const totals = new Map<string, { sum: number; count: number }>()
  for (const signal of signals) {
    if (!signal.topicId) continue
    const entry = totals.get(signal.topicId) ?? { sum: 0, count: 0 }
    entry.sum += signal.score
    entry.count += 1
    totals.set(signal.topicId, entry)
  }
  return new Map([...totals].map(([topicId, { sum, count }]) => [topicId, sum / count]))
}

/**
 * Applies one graded exam submission to the student's mastery and review schedules: for every topic
 * the exam asked about, mastery is recomputed (the exam signals are already stored) and the topic's
 * review is rescheduled, like a quiz attempt.
 *
 * It runs at most once per grading. `reviewAppliedAt` is claimed first with a conditional update, so two
 * pages or tabs that open the results together apply it once; the grading job clears the mark when a
 * regrade replaces the result, so the new grading is applied in turn. A failure puts the mark back so
 * the next visit tries again. Returns whether this call applied it.
 *
 * The same claim guards the evidence: the graded questions that name concepts are written as exam
 * evidence under the session key `exam:<submissionId>`, replacing what an earlier grading of the same
 * submission wrote (spec §5.9). It runs after the schedules, like a quiz, so the concept view wins.
 * `evidenceRecordedAt` says whether the write happened: a failed write leaves it unset and the next
 * visit to the course writes it again (retryPendingExamEvidence).
 */
export async function applyGradedExam(userId: string, projectId: string, submissionId: string): Promise<boolean> {
  const claim = await prisma.examSubmission.updateMany({
    where: { id: submissionId, userId, status: 'submitted', gradedAt: { not: null }, reviewAppliedAt: null },
    // A new grading owes its evidence again until it is written.
    data: { reviewAppliedAt: new Date(), evidenceRecordedAt: null, evidenceAttempts: 0, evidenceTriedAt: null },
  })
  if (claim.count === 0) return false

  try {
    const signals = await prisma.learningSignal.findMany({
      where: {
        userId,
        projectId,
        source: 'exam',
        topicId: { not: null },
        metadata: { path: ['submission_id'], equals: submissionId },
      },
      select: { topicId: true, score: true },
    })
    const scores = scoresByTopic(signals)
    if (scores.size > 0) {
      const existing = await prisma.topic.findMany({
        where: { id: { in: [...scores.keys()] }, projectId },
        select: { id: true },
      })
      for (const { id: topicId } of existing) {
        const mastery = await computeTopicMastery(userId, projectId, topicId)
        await upsertReviewSchedule({
          userId,
          projectId,
          topicId,
          mastery: mastery.mastery,
          wasCorrect: (scores.get(topicId) ?? 0) >= EXAM_PASS_SHARE,
        })
      }
    }

    await recordSubmissionEvidence(userId, projectId, submissionId)
    return true
  } catch (error) {
    await prisma.examSubmission
      .updateMany({ where: { id: submissionId, userId }, data: { reviewAppliedAt: null } })
      .catch(() => undefined)
    throw error
  }
}

/** Applies every graded submission of a course that has not been applied yet (a few at a time). */
export async function applyPendingExamResults(userId: string, projectId: string): Promise<number> {
  const pending = await prisma.examSubmission.findMany({
    where: {
      userId,
      status: 'submitted',
      gradedAt: { not: null },
      reviewAppliedAt: null,
      sampleExam: { projectId, project: { userId } },
    },
    orderBy: { gradedAt: 'asc' },
    take: 10,
    select: { id: true },
  })
  let applied = 0
  for (const { id } of pending) {
    try {
      if (await applyGradedExam(userId, projectId, id)) applied += 1
    } catch (error) {
      logServerError('Applying a graded exam to mastery failed', error)
    }
  }
  await retryPendingExamEvidence(userId, projectId)
  return applied
}

/**
 * Tries again the evidence of graded submissions that owe it (applied to the schedules, but the
 * evidence write failed), a few at a time, oldest first. Returns how many it wrote.
 */
export async function retryPendingExamEvidence(userId: string, projectId: string, limit = RETRY_LIMIT): Promise<number> {
  try {
    const owed = await prisma.examSubmission.findMany({
      where: {
        userId,
        status: 'submitted',
        gradedAt: { not: null },
        reviewAppliedAt: { not: null },
        evidenceRecordedAt: null,
        ...dueForEvidenceRetry(),
        sampleExam: { projectId, project: { userId } },
      },
      orderBy: { gradedAt: 'asc' },
      take: limit,
      select: { id: true },
    })
    let written = 0
    for (const { id } of owed) {
      if (await recordSubmissionEvidence(userId, projectId, id)) written += 1
    }
    return written
  } catch (error) {
    logServerError('Retrying exam evidence failed', error)
    return 0
  }
}
