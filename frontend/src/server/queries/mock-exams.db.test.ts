/**
 * The exam results page's reading of a submission against a real, migrated Postgres (DATABASE_URL). Skipped when no
 * database with the exam tables answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let queries: typeof import('./mock-exams')
let jobs: typeof import('@/lib/jobs/active-jobs')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  queries = await import('./mock-exams')
  jobs = await import('@/lib/jobs/active-jobs')
  available = await prisma.$queryRaw`SELECT 1 FROM exam_submissions LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

async function world(grading: object | null) {
  const user = await prisma.user.create({ data: { email: `me-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const exam = await prisma.sampleExam.create({
    data: {
      projectId: project.id,
      name: 'Sample Exam - 2026-11-20',
      durationMinutes: 30,
      difficultyLevel: 'medium',
      topicsCovered: [],
      questions: [{ question_type: 'true_false', question_text: 'Q?', correct_answer: true, points: 1 }],
    },
  })
  const submission = await prisma.examSubmission.create({
    data: { sampleExamId: exam.id, userId: user.id, answers: {}, status: 'submitted', submittedAt: new Date(Date.now() - 3_600_000), startedAt: new Date(Date.now() - 7_200_000), ...(grading ? { aiGrading: grading } : {}) },
  })
  return { user, project, exam, submission }
}

const GRADING = { total_points: 1, earned_points: 1, overall_score: 100, graded_questions: [{ question_index: 0, question_type: 'true_false', points_possible: 1, points_earned: 1, is_correct: true, feedback: 'Yes.', needs_review: false }] }

test('a job that finishes between the read of the submission and the read of its job is graded, not a failed grading', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world(null)
  await prisma.processingJob.create({
    data: { userId: w.user.id, projectId: w.project.id, jobType: 'grade_exam', status: 'completed', targetKey: jobs.gradeExamTarget(w.submission.id), inputData: {}, completedAt: new Date() },
  })
  // The grading lands just after the page has read the submission, while it is reading the job.
  const real = prisma.processingJob.findFirst.bind(prisma.processingJob)
  let wrote = false
  const patched = prisma.processingJob as unknown as { findFirst: unknown }
  patched.findFirst = (async (args: Parameters<typeof real>[0]) => {
    if (!wrote) {
      wrote = true
      await prisma.examSubmission.update({ where: { id: w.submission.id }, data: { aiGrading: GRADING } })
    }
    return real(args)
  }) as typeof real
  try {
    const result = await queries.getExamResult(w.user.id, w.project.id, w.exam.id, w.submission.id)
    assert.equal(result?.status, 'graded')
  } finally {
    patched.findFirst = real
  }
})

test('a finished job that left no grading in the submission is still a failed grading, and a graded one is graded', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const failed = await world(null)
  await prisma.processingJob.create({
    data: { userId: failed.user.id, projectId: failed.project.id, jobType: 'grade_exam', status: 'completed', targetKey: jobs.gradeExamTarget(failed.submission.id), inputData: {}, completedAt: new Date() },
  })
  assert.equal((await queries.getExamResult(failed.user.id, failed.project.id, failed.exam.id, failed.submission.id))?.status, 'failed')
  const graded = await world(GRADING)
  assert.equal((await queries.getExamResult(graded.user.id, graded.project.id, graded.exam.id, graded.submission.id))?.status, 'graded')
})
