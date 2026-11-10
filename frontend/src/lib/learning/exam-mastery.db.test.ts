/**
 * Applying a graded exam to the learner model, against a real, migrated Postgres (DATABASE_URL).
 * Skipped when no database with the exam_submissions and evidence_events tables answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./exam-mastery')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./exam-mastery')
  available = await prisma.$queryRaw`SELECT 1 FROM evidence_events LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

const dbTest = (name: string, run: () => Promise<void>) =>
  test(name, async (t) => {
    if (!available) return t.skip('no migrated test database')
    await run()
  })

const graded = (index: number, type: string, earned: number, possible: number, extra: Record<string, unknown> = {}) => ({
  question_index: index,
  question_type: type,
  points_possible: possible,
  points_earned: earned,
  is_correct: earned >= possible * 0.7,
  feedback: '',
  needs_review: false,
  ...extra,
})

const grading = (questions: ReturnType<typeof graded>[]) => ({
  overall_score: 50,
  earned_points: 1,
  total_points: 2,
  graded_questions: questions,
})

async function world() {
  const user = await prisma.user.create({ data: { email: `em-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const concept = await prisma.concept.create({
    data: { projectId: project.id, topicId: topic.id, name: 'C', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  const exam = await prisma.sampleExam.create({
    data: {
      projectId: project.id,
      name: 'E',
      durationMinutes: 30,
      difficultyLevel: 'medium',
      questions: [
        { question_type: 'multiple_choice', topic_id: topic.id, concept_ids: [concept.id], correct_answer: 'A', options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }], points: 1 },
        { question_type: 'true_false', topic_id: topic.id, concept_ids: [concept.id], correct_answer: true, points: 1 },
        { question_type: 'true_false', topic_id: topic.id, concept_ids: [], correct_answer: true, points: 1 },
      ],
    },
  })
  const submission = await prisma.examSubmission.create({
    data: {
      sampleExamId: exam.id,
      userId: user.id,
      status: 'submitted',
      answers: { '0': { answer: 'B', confidence: 0.95 }, '1': 'true', '2': 'true' },
      aiGrading: grading([graded(0, 'multiple_choice', 0, 1), graded(1, 'true_false', 1, 1), graded(2, 'true_false', 1, 1)]),
      gradedAt: new Date(),
    },
  })
  return { user, project, topic, concept, exam, submission }
}

const events = (w: Awaited<ReturnType<typeof world>>) =>
  prisma.evidenceEvent.findMany({
    where: { userId: w.user.id, sessionKey: `exam:${w.submission.id}`, source: 'exam' },
    orderBy: { itemKey: 'asc' },
  })

dbTest('exam apply writes evidence once', async () => {
  const w = await world()
  assert.equal(await mod.applyGradedExam(w.user.id, w.project.id, w.submission.id), true)
  const written = await events(w)
  // Two answered questions name the concept; the third names none.
  assert.deepEqual(written.map((e) => [e.itemKey, e.score, e.confidence, e.topicId]), [
    [`exam:${w.exam.id}:0`, 0, 0.95, w.topic.id],
    [`exam:${w.exam.id}:1`, 1, null, w.topic.id],
  ])

  // The claim is taken: a second look applies nothing and adds nothing.
  assert.equal(await mod.applyGradedExam(w.user.id, w.project.id, w.submission.id), false)
  assert.equal((await events(w)).length, 2)
})

dbTest('regrade replaces exam evidence', async () => {
  const w = await world()
  await mod.applyGradedExam(w.user.id, w.project.id, w.submission.id)

  // A regrade: the grading job stores a different result and clears the mark.
  await prisma.examSubmission.update({
    where: { id: w.submission.id },
    data: {
      aiGrading: grading([graded(0, 'multiple_choice', 1, 1), graded(1, 'true_false', 0, 1), graded(2, 'true_false', 1, 1)]),
      gradedAt: new Date(),
      reviewAppliedAt: null,
    },
  })
  assert.equal(await mod.applyGradedExam(w.user.id, w.project.id, w.submission.id), true)

  const written = await events(w)
  assert.deepEqual(written.map((e) => [e.itemKey, e.score]), [
    [`exam:${w.exam.id}:0`, 1],
    [`exam:${w.exam.id}:1`, 0],
  ])
})

const backdateTry = (id: string) =>
  prisma.examSubmission.update({ where: { id }, data: { evidenceTriedAt: new Date(Date.now() - 2 * 3600_000) } })

dbTest('exam evidence that failed to write is tried again on the next visit', async () => {
  const { failEvidenceWrites } = await import('./evidence-test-support')
  const w = await world()
  const restore = await failEvidenceWrites(prisma, w.user.id)
  try {
    // The apply itself succeeds; the evidence write is refused and logged.
    assert.equal(await mod.applyGradedExam(w.user.id, w.project.id, w.submission.id), true)
  } finally {
    await restore()
  }
  assert.equal((await events(w)).length, 0)
  const owed = await prisma.examSubmission.findUniqueOrThrow({ where: { id: w.submission.id } })
  assert.equal(owed.evidenceRecordedAt, null)
  assert.ok(owed.reviewAppliedAt)

  // A failed write is not tried again within the hour; a later visit writes it, once, and marks it.
  assert.equal(owed.evidenceAttempts, 1)
  assert.equal(await mod.retryPendingExamEvidence(w.user.id, w.project.id), 0)
  await backdateTry(w.submission.id)
  await mod.applyPendingExamResults(w.user.id, w.project.id)
  assert.equal((await events(w)).length, 2)
  const done = await prisma.examSubmission.findUniqueOrThrow({ where: { id: w.submission.id } })
  assert.ok(done.evidenceRecordedAt)

  // Nothing is owed any more: another visit changes nothing.
  assert.equal(await mod.retryPendingExamEvidence(w.user.id, w.project.id), 0)
  assert.equal((await events(w)).length, 2)
})
