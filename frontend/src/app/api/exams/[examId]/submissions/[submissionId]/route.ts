/**
 * GET /api/exams/[examId]/submissions/[submissionId]
 *
 * The results of one submission: score, each question with the student's answer, the
 * correct answer, points and feedback, and a per-topic summary. The answer key is released
 * here and only here, and only once the submission is submitted and graded.
 */

import { logServerError } from '@/lib/ops/log'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { gradeExamTarget } from '@/lib/jobs/active-jobs'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { ATTEMPT_SUBMITTED } from '@/lib/exams/attempts'
import { buildQuestionResults, readOverall, summarizeTopics } from '@/lib/exams/results'

export const dynamic = 'force-dynamic'

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ examId: string; submissionId: string }> }
) {
  try {
    const session = await requireAuth()
    const { examId, submissionId } = await params

    const submission = await prisma.examSubmission.findFirst({
      where: {
        id: submissionId,
        sampleExamId: examId,
        userId: session.user.id,
        // An attempt still in progress has no results, and its key must stay private.
        status: ATTEMPT_SUBMITTED,
      },
      include: {
        sampleExam: { select: { name: true, projectId: true, questions: true } },
      },
    })
    if (!submission) return apiNotFound('Submission not found')

    const gradingJob = await prisma.processingJob.findFirst({
      where: { userId: session.user.id, jobType: 'grade_exam', targetKey: gradeExamTarget(submission.id) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, errorCode: true },
    })
    const jobRunning = gradingJob?.status === 'pending' || gradingJob?.status === 'processing'

    const overall = readOverall(submission.aiGrading)
    const base = {
      id: submission.id,
      examId,
      examName: submission.sampleExam.name,
      projectId: submission.sampleExam.projectId,
      submittedAt: submission.submittedAt,
      gradedAt: submission.gradedAt,
      gradingJob,
    }

    if (!overall) {
      return NextResponse.json({
        submission: {
          ...base,
          // 'grading' while a job runs; otherwise it never finished.
          status: jobRunning ? 'grading' : 'failed',
          score: null,
          earnedPoints: null,
          totalPoints: null,
          questions: [],
          topics: [],
        },
      })
    }

    const questions = buildQuestionResults(
      submission.sampleExam.questions,
      submission.aiGrading,
      submission.answers
    )

    // Link a topic only while it still exists (topics can be merged or deleted).
    const topicIds = [...new Set(questions.map((q) => q.topicId).filter((id): id is string => !!id))]
    const existing = topicIds.length
      ? await prisma.topic.findMany({
          where: { id: { in: topicIds }, projectId: submission.sampleExam.projectId },
          select: { id: true, name: true },
        })
      : []
    const currentNames = new Map(existing.map((topic) => [topic.id, topic.name]))
    const topics = summarizeTopics(questions).map((topic) => ({
      ...topic,
      topicName: (topic.topicId && currentNames.get(topic.topicId)) || topic.topicName,
      linkable: !!topic.topicId && currentNames.has(topic.topicId),
    }))

    return NextResponse.json({
      submission: {
        ...base,
        status: 'graded',
        score: overall.score,
        earnedPoints: overall.earned,
        totalPoints: overall.total,
        needsReviewCount: questions.filter((q) => q.needsReview).length,
        questions,
        topics,
      },
    })
  } catch (error) {
    logServerError('Error loading exam results', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Internal server error')
  }
}
