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

dbTest('backfill skips what was already recorded live and still does the rest', async () => {
  const w = await world()
  const { attempt } = await addQuiz(w)
  const { submission } = await addExam(w)
  // The quiz was recorded live (session key quiz:<attempt>), the exam was not.
  await prisma.evidenceEvent.create({
    data: {
      userId: w.user.id,
      projectId: w.project.id,
      topicId: w.topic.id,
      conceptId: w.concept.id,
      itemKey: `quiz:${attempt.quizSetId}:0`,
      source: 'quiz',
      score: 1,
      assistance: 0,
      weight: 1,
      role: 'primary',
      gradedBy: 'rule',
      sessionKey: `quiz:${attempt.id}`,
    },
  })
  await mod.backfillEvidence(w.user.id, w.project.id)
  const rows = await eventsOf(w)
  assert.equal(rows.filter((row) => row.source === 'quiz').length, 1)
  assert.equal(rows.filter((row) => row.source === 'exam' && (row.metadata as { backfillOf?: string }).backfillOf === submission.id).length, 1)
})

dbTest('backfill maps revealed practice to level 1', async () => {
  const w = await world()
  await addPractice(w)
  await mod.backfillEvidence(w.user.id, w.project.id)
  const rows = (await eventsOf(w)).filter((row) => row.source === 'practice')
  const byStep = new Map(rows.map((row) => [row.itemKey.split(':').pop(), row]))
  // Solved without a hint: level 0. The old hint is the connect hint (rung 3): a failed first try, level 1. Answer shown: level 1, score 0.
  assert.deepEqual([byStep.get('0')!.assistance, byStep.get('0')!.score], [0, 0.6])
  assert.deepEqual([byStep.get('1')!.assistance, byStep.get('1')!.score], [1, 0])
  assert.deepEqual([byStep.get('2')!.assistance, byStep.get('2')!.score], [1, 0])
  assert.ok(rows.every((row) => (row.metadata as { backfillOf?: string }).backfillOf))
})

dbTest('a step the row recorded as first try scores 1', async () => {
  const w = await world()
  await addPractice(w, { attemptedSteps: [0, 1, 2], firstTrySteps: [0] })
  await mod.backfillEvidence(w.user.id, w.project.id)
  const rows = (await eventsOf(w)).filter((row) => row.source === 'practice' && row.itemKey.endsWith(':0'))
  assert.deepEqual(rows.map((row) => [row.assistance, row.score]), [[0, 1]])
})

dbTest('a quiz with no concept ids, and a retired concept, write nothing', async () => {
  const w = await world()
  const { set } = await addQuiz(w)
  await prisma.topicQuiz.update({ where: { id: set.id }, data: { questions: [{ question_type: 'true_false', question_text: 'q', correct_answer: true }] } })
  const result = await mod.backfillEvidence(w.user.id, w.project.id)
  assert.equal(result.events, 0)
  // The project is still marked: the history had nothing to convert.
  const marker = await prisma.project.findUniqueOrThrow({ where: { id: w.project.id }, select: { evidenceBackfilledAt: true } })
  assert.ok(marker.evidenceBackfilledAt)
})

const markerOf = async (w: World, topicId: string) =>
  (await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { evidenceBackfilledAt: true } })).evidenceBackfilledAt
const projectMarker = async (w: World) =>
  (await prisma.project.findUniqueOrThrow({ where: { id: w.project.id }, select: { evidenceBackfilledAt: true } })).evidenceBackfilledAt
const later = (minutes: number) => new Date(Date.now() + minutes * 60 * 1000)

dbTest('readiness is per topic: a topic with concepts is converted and marked, one without keeps waiting', async () => {
  const w = await world({ conceptsOnSecondTopic: false })
  await addQuiz(w)
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'ran')
  assert.ok((await eventsOf(w)).length > 0)
  assert.ok(await markerOf(w, w.topic.id))
  assert.equal(await markerOf(w, w.topic2.id), null)
  assert.equal(await projectMarker(w), null)
  // The other topic has nothing ready yet; the lease paces the next try.
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'waiting')

  await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic2.id, name: 'C2', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'ran')
  assert.ok(await markerOf(w, w.topic2.id))
  assert.ok(await projectMarker(w))
  const count = (await eventsOf(w)).length
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'done')
  assert.equal((await eventsOf(w)).length, count)
})

dbTest('an exam across a ready and a not-ready topic waits for both; the ready topic is marked and does not reload history', async () => {
  const w = await world({ conceptsOnSecondTopic: false })
  const exam = await prisma.sampleExam.create({
    data: {
      projectId: w.project.id,
      name: 'E',
      durationMinutes: 30,
      difficultyLevel: 'medium',
      questions: [
        { question_type: 'true_false', topic_id: w.topic.id, concept_ids: [w.concept.id], correct_answer: true, points: 1 },
        { question_type: 'true_false', topic_id: w.topic2.id, concept_ids: [w.concept.id], correct_answer: true, points: 1 },
      ],
    },
  })
  const submission = await prisma.examSubmission.create({
    data: {
      sampleExamId: exam.id,
      userId: w.user.id,
      status: 'submitted',
      answers: { '0': 'true', '1': 'true' },
      aiGrading: {
        graded_questions: [0, 1].map((question_index) => ({ question_index, question_type: 'true_false', points_possible: 1, points_earned: 1, is_correct: true, feedback: '', needs_review: false })),
      },
      submittedAt: day(4),
      gradedAt: day(4),
    },
  })
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'ran')
  assert.equal((await eventsOf(w)).filter((row) => row.source === 'exam').length, 0)
  assert.ok(await markerOf(w, w.topic.id), 'the ready topic is converted; the exam is looked at when the other topic is ready')
  // Nothing is ready and unconverted, so the overview does not scan the history again, and the lease is free.
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'waiting')
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: w.project.id } })).evidenceBackfillClaimedAt, null)

  await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic2.id, name: 'C2', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'ran')
  const exams = (await eventsOf(w)).filter((row) => row.source === 'exam')
  assert.equal(exams.length, 2)
  assert.ok(exams.every((row) => (row.metadata as { backfillOf: string }).backfillOf === submission.id))
  assert.ok(await markerOf(w, w.topic.id))
  assert.ok(await markerOf(w, w.topic2.id))
})

dbTest('a topic whose extraction never produced concepts is never marked and its history is left alone', async () => {
  const w = await world({ conceptsOnSecondTopic: false })
  await prisma.quizAttempt.create({ data: { userId: w.user.id, topicId: w.topic2.id, answers: {}, results: {}, score: 90 } })
  await mod.backfillEvidence(w.user.id, w.project.id)
  assert.equal(await markerOf(w, w.topic2.id), null)
  assert.equal((await eventsOf(w)).length, 0)
})

dbTest('two backfillIfDue calls at once write one set of events', async () => {
  const w = await world()
  await addQuiz(w)
  await addExam(w)
  const [a, b] = await Promise.all([mod.backfillIfDue(w.user.id, w.project.id), mod.backfillIfDue(w.user.id, w.project.id)])
  assert.deepEqual([a, b].sort(), ['busy', 'ran'])
  assert.equal((await eventsOf(w)).filter((row) => row.source === 'quiz').length, 2)
})

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

dbTest('a run that fails marks nothing and keeps its lease; the retry after the lease finishes', async () => {
  const w = await world()
  await addQuiz(w)
  await assert.rejects(mod.backfillIfDue(w.user.id, w.project.id, { timeZone: 'Not/AZone' }))
  assert.equal(await markerOf(w, w.topic.id), null)
  assert.equal(await projectMarker(w), null)
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'busy')
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id, { now: later(11) }), 'ran')
  assert.ok(await markerOf(w, w.topic.id))
})

dbTest('converting a topic switches its schedule from the blend to concept mastery', async () => {
  const w = await world()
  const { attempt } = await addQuiz(w)
  const blend = (await import('./mastery')).computeTopicMastery
  const before = await blend(w.user.id, w.project.id, w.topic.id)
  assert.ok(before.mastery > 0)
  await mod.backfillEvidence(w.user.id, w.project.id)
  const after = await blend(w.user.id, w.project.id, w.topic.id)
  const schedule = await prisma.reviewSchedule.findUniqueOrThrow({ where: { userId_topicId: { userId: w.user.id, topicId: w.topic.id } } })
  assert.ok(Math.abs(schedule.mastery - after.mastery) < 1e-6, `${schedule.mastery} vs ${after.mastery}`)
  assert.ok(after.mastery <= 0.5 + 1e-9, 'two answers on one concept in one sitting cannot be solid')
  void attempt
})

dbTest('bookkeeping does not move the course\'s updatedAt, which orders the student\'s courses', async () => {
  const w = await world()
  await addQuiz(w)
  const before = (await prisma.project.findUniqueOrThrow({ where: { id: w.project.id } })).updatedAt
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id), 'ran')
  assert.ok(await projectMarker(w))
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: w.project.id } })).updatedAt.getTime(), before.getTime())
})

dbTest('a topic-page conversion reads and marks only that topic and leaves the others for the overview', async () => {
  const w = await world()
  await addQuiz(w) // topic
  await addPractice(w) // topic
  await addExam(w) // topic2

  assert.equal(await mod.convertTopicIfDue(w.user.id, w.project.id, w.topic2.id), true)
  let rows = await eventsOf(w)
  assert.ok(rows.some((row) => row.source === 'exam'))
  assert.equal(rows.filter((row) => row.source === 'quiz' || row.source === 'practice').length, 0)
  assert.ok((await prisma.topic.findUniqueOrThrow({ where: { id: w.topic2.id } })).evidenceBackfilledAt)
  assert.equal((await prisma.topic.findUniqueOrThrow({ where: { id: w.topic.id } })).evidenceBackfilledAt, null)
  // The project is not marked while a topic waits, and the lease is not left held.
  const project = await prisma.project.findUniqueOrThrow({ where: { id: w.project.id }, select: { evidenceBackfilledAt: true, evidenceBackfillClaimedAt: true } })
  assert.equal(project.evidenceBackfilledAt, null)
  assert.equal(project.evidenceBackfillClaimedAt, null)

  // The other topic converts on its own page, and nothing is written twice.
  assert.equal(await mod.convertTopicIfDue(w.user.id, w.project.id, w.topic.id), true)
  rows = await eventsOf(w)
  assert.ok(rows.some((row) => row.source === 'quiz') && rows.some((row) => row.source === 'practice'))
  assert.equal(rows.filter((row) => row.source === 'exam').length, 1)
  assert.ok((await prisma.project.findUniqueOrThrow({ where: { id: w.project.id } })).evidenceBackfilledAt)
  const settled = (await eventsOf(w)).length
  assert.equal((await mod.backfillEvidence(w.user.id, w.project.id)).events, 0)
  assert.equal((await eventsOf(w)).length, settled)
})

dbTest('a topic-page conversion that finds another run holding the lease reports false', async () => {
  const w = await world()
  await addQuiz(w)
  await prisma.$executeRaw`UPDATE projects SET evidence_backfill_claimed_at = now() AT TIME ZONE 'UTC' WHERE id = ${w.project.id}`
  assert.equal(await mod.convertTopicIfDue(w.user.id, w.project.id, w.topic.id), false)
  assert.equal((await prisma.topic.findUniqueOrThrow({ where: { id: w.topic.id } })).evidenceBackfilledAt, null)
})

dbTest('a topic run that fails releases its lease, and never clears a lease another run took', async () => {
  const w = await world()
  await addQuiz(w)
  const claimed = () => prisma.project.findUniqueOrThrow({ where: { id: w.project.id }, select: { evidenceBackfillClaimedAt: true } })
  await assert.rejects(mod.backfillIfDue(w.user.id, w.project.id, { timeZone: 'Not/AZone', topicId: w.topic.id }))
  assert.equal((await claimed()).evidenceBackfillClaimedAt, null)
  assert.equal(await markerOf(w, w.topic.id), null)

  // The lease ran out during a slow run and another run took it: the first run's finish leaves the new claim alone.
  const takenOver = new Date(Date.now() + 5 * 60 * 1000)
  await prisma.$executeRaw`UPDATE projects SET evidence_backfill_claimed_at = (${takenOver} AT TIME ZONE 'UTC') WHERE id = ${w.project.id}`
  assert.equal(await mod.backfillIfDue(w.user.id, w.project.id, { topicId: w.topic.id }), 'busy')
  assert.ok((await claimed()).evidenceBackfillClaimedAt)
})
