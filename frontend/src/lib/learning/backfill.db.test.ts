/**
 * Turning a project's history into learner-model evidence (spec §12), against a real, migrated
 * Postgres (DATABASE_URL). Skipped when no database with the evidence_backfilled_at column answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./backfill')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./backfill')
  available = await prisma.$queryRaw`SELECT evidence_backfilled_at FROM projects LIMIT 1`.then(
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

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)

const step = (n: number) => ({
  step_number: n,
  question: `Question ${n}`,
  hints: ['Look at the given.', 'The idea applies.', 'The general form.'],
  answer_type: 'text',
  correct_answer: `answer ${n}`,
})

async function world(opts: { conceptsOnSecondTopic?: boolean } = {}) {
  const user = await prisma.user.create({ data: { email: `bf-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const topic2 = await prisma.topic.create({ data: { projectId: project.id, name: 'T2', orderIndex: 1, userConfirmed: true } })
  const concept = await prisma.concept.create({
    data: { projectId: project.id, topicId: topic.id, name: 'C', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  const concept2 =
    opts.conceptsOnSecondTopic === false
      ? null
      : await prisma.concept.create({
          data: { projectId: project.id, topicId: topic2.id, name: 'C2', summary: 's', kind: 'concept', orderIndex: 0 },
        })
  return { user, project, topic, topic2, concept, concept2 }
}

type World = Awaited<ReturnType<typeof world>>

const addQuiz = async (w: World) => {
  const set = await prisma.topicQuiz.create({
    data: {
      topicId: w.topic.id,
      questions: [
        { question_type: 'multiple_choice', question_text: 'q0', concept_ids: [w.concept.id], correct_answer: 'A', options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }] },
        { question_type: 'true_false', question_text: 'q1', concept_ids: [w.concept.id], correct_answer: true },
        { question_type: 'true_false', question_text: 'q2 untagged', correct_answer: true },
      ],
    },
  })
  const attempt = await prisma.quizAttempt.create({
    data: {
      userId: w.user.id,
      topicId: w.topic.id,
      quizSetId: set.id,
      answers: { '0': 'A', '1': 'false', '2': 'true' },
      results: {
        '0': { isCorrect: true, pointsEarned: 1, pointsPossible: 1 },
        '1': { isCorrect: false, pointsEarned: 0, pointsPossible: 1 },
        '2': { isCorrect: true, pointsEarned: 1, pointsPossible: 1 },
      },
      score: 66,
      takenAt: day(5),
    },
  })
  return { set, attempt }
}

const addExam = async (w: World) => {
  const exam = await prisma.sampleExam.create({
    data: {
      projectId: w.project.id,
      name: 'E',
      durationMinutes: 30,
      difficultyLevel: 'medium',
      questions: [{ question_type: 'true_false', topic_id: w.topic2.id, concept_ids: [w.concept2!.id], correct_answer: true, points: 1 }],
    },
  })
  const submission = await prisma.examSubmission.create({
    data: {
      sampleExamId: exam.id,
      userId: w.user.id,
      status: 'submitted',
      answers: { '0': 'true' },
      aiGrading: {
        overall_score: 100,
        graded_questions: [
          { question_index: 0, question_type: 'true_false', points_possible: 1, points_earned: 1, is_correct: true, feedback: '', needs_review: false },
        ],
      },
      submittedAt: day(4),
      gradedAt: day(4),
    },
  })
  return { exam, submission }
}

const addPractice = async (w: World, rowExtra: Record<string, unknown> = {}) => {
  const content = await prisma.topicContent.create({
    data: {
      topicId: w.topic.id,
      contentType: 'interactive_examples',
      contentData: [{ title: 'P1', problem_statement: 'x', concept_ids: [w.concept.id], steps: [step(1), step(2), step(3)] }],
    },
  })
  const row = await prisma.practiceProgress.create({
    data: {
      userId: w.user.id,
      topicId: w.topic.id,
      contentId: content.id,
      problemIndex: 0,
      problemTitle: 'P1',
      stepsSolved: 2,
      stepsTotal: 3,
      hintsUsed: 1,
      // Step 0 solved clean, step 1 solved after the old hint, step 2 answer shown.
      solvedSteps: [0, 1],
      revealedSteps: [2],
      hintedSteps: [1],
      attemptedSteps: [],
      firstTrySteps: [],
      updatedAt: day(3),
      ...rowExtra,
    },
  })
  return { content, row }
}

const addVoice = async (w: World) => {
  const session = await prisma.voiceDrillSession.create({
    data: {
      userId: w.user.id,
      projectId: w.project.id,
      topicId: w.topic.id,
      questionSet: [
        { question_type: 'conceptual', question_text: 'v0', concept_ids: [w.concept.id], topic_id: w.topic.id },
        { question_type: 'conceptual', question_text: 'v1', topic_id: w.topic.id },
        { question_type: 'conceptual', question_text: 'v2', concept_ids: [w.concept.id], topic_id: w.topic.id },
      ],
    },
  })
  const mk = (questionIndex: number, score: number, feedback: object) =>
    prisma.voiceDrillAttempt.create({
      data: {
        sessionId: session.id,
        userId: w.user.id,
        topicId: w.topic.id,
        questionIndex,
        questionType: 'conceptual',
        questionText: `v${questionIndex}`,
        userAnswer: 'something',
        isCorrect: score >= 0.7,
        score,
        feedback,
        createdAt: day(2),
      },
    })
  await mk(0, 0.9, { comment: 'ok' })
  await mk(1, 0.9, { comment: 'ok' })
  await mk(2, 0, { comment: 'not graded', ungraded: true })
  return session
}

const eventsOf = (w: World) =>
  prisma.evidenceEvent.findMany({ where: { userId: w.user.id }, orderBy: [{ createdAt: 'asc' }, { itemKey: 'asc' }] })

dbTest('backfill turns quiz, exam, practice and voice history into events', async () => {
  const w = await world()
  const { attempt } = await addQuiz(w)
  const { submission } = await addExam(w)
  await addPractice(w)
  const session = await addVoice(w)

  const result = await mod.backfillEvidence(w.user.id, w.project.id)
  const rows = await eventsOf(w)
  assert.equal(result.events, rows.filter((row) => row.source !== 'implicit').length)

  const quiz = rows.filter((row) => row.source === 'quiz')
  assert.deepEqual(quiz.map((row) => [row.score, row.assistance]), [[1, 0], [0, 0]])
  assert.ok(quiz.every((row) => row.sessionKey === `quiz:${attempt.id}`))
  assert.ok(quiz.every((row) => (row.metadata as { backfillOf: string }).backfillOf === attempt.id))
  assert.equal(quiz[0].createdAt.getTime(), attempt.takenAt.getTime())

  const exam = rows.filter((row) => row.source === 'exam')
  assert.equal(exam.length, 1)
  assert.equal(exam[0].conceptId, w.concept2!.id)
  assert.equal((exam[0].metadata as { backfillOf: string }).backfillOf, submission.id)

  const voice = rows.filter((row) => row.source === 'voice')
  assert.deepEqual(voice.map((row) => [row.itemKey, row.score, row.assistance]), [[`voice:${session.id}:0`, 0.9, 0]])

  const marker = await prisma.project.findUniqueOrThrow({ where: { id: w.project.id }, select: { evidenceBackfilledAt: true } })
  assert.ok(marker.evidenceBackfilledAt)
  // Memory was replayed: the first concept has a card and the topic has a schedule.
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: w.concept.id } } })
  assert.ok(memory.nUnassisted > 0)
  assert.ok(await prisma.reviewSchedule.findUnique({ where: { userId_topicId: { userId: w.user.id, topicId: w.topic.id } } }))
})

dbTest('backfill is idempotent', async () => {
  const w = await world()
  await addQuiz(w)
  await addExam(w)
  await addPractice(w)
  await addVoice(w)

  const first = await mod.backfillEvidence(w.user.id, w.project.id)
  assert.ok(first.events > 0)
  const before = await eventsOf(w)
  const memoryBefore = await prisma.conceptMemory.findMany({ where: { userId: w.user.id }, orderBy: { conceptId: 'asc' } })

  const second = await mod.backfillEvidence(w.user.id, w.project.id)
  assert.equal(second.events, 0)
  const after = await eventsOf(w)
  assert.equal(after.length, before.length)
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id))
  const memoryAfter = await prisma.conceptMemory.findMany({ where: { userId: w.user.id }, orderBy: { conceptId: 'asc' } })
  assert.deepEqual(memoryAfter.map((row) => [row.conceptId, row.mastery, row.nUnassisted]), memoryBefore.map((row) => [row.conceptId, row.mastery, row.nUnassisted]))
})

const markerOf = async (w: World, topicId: string) =>
  (await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { evidenceBackfilledAt: true } })).evidenceBackfilledAt
const projectMarker = async (w: World) =>
  (await prisma.project.findUniqueOrThrow({ where: { id: w.project.id }, select: { evidenceBackfilledAt: true } })).evidenceBackfilledAt
const later = (minutes: number) => new Date(Date.now() + minutes * 60 * 1000)

dbTest('a run that died is picked up after its lease, and a live lease keeps others away', async () => {
  const w = await world()
  await addQuiz(w)
  // A run claimed the project a minute ago and never finished: nothing is marked, so nothing is lost.
  await prisma.project.update({ where: { id: w.project.id }, data: { evidenceBackfillClaimedAt: later(-1) } })
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'busy')
  assert.equal((await eventsOf(w)).length, 0)
  assert.equal(await markerOf(w, w.topic.id), null)
  assert.equal(await projectMarker(w), null)
  // Once the lease has expired the next call runs it to the end.
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id, { now: later(mod.BACKFILL_LEASE_MS / 60_000 + 1) }), 'ran')
  assert.ok((await eventsOf(w)).length > 0)
  assert.ok(await markerOf(w, w.topic.id))
  assert.ok(await projectMarker(w))
})
