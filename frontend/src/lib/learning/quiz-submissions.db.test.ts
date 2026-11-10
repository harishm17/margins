/**
 * Applying and queueing a quiz that waited for the AI, against a real, migrated Postgres
 * (DATABASE_URL). Skipped when no database with the quiz_submissions table answers.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'

// Read when the dispatcher module loads: an AI service nobody listens to, one try, and the grading
// task sent inline so a failed dispatch reaches startQuizGrading.
process.env.AI_SERVICE_URL = 'http://127.0.0.1:9'
process.env.DIRECT_TASK_MAX_RETRIES = '1'
process.env.DIRECT_INLINE_JOB_TYPES = 'grade_quiz'

// Loaded in `before`, once the environment above is set (the dispatcher reads it at import).
let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./quiz-submissions')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./quiz-submissions')
  available = await prisma.$queryRaw`SELECT 1 FROM quiz_submissions LIMIT 1`.then(
    () => true,
    () => false
  )
})

const dbTest = (name: string, run: () => Promise<void>) =>
  test(name, async (t) => {
    if (!available) return t.skip('no migrated test database')
    await run()
  })

const applyPendingQuizResults: typeof import('./quiz-submissions').applyPendingQuizResults = (...args) => mod.applyPendingQuizResults(...args)
const applyQuizSubmission: typeof import('./quiz-submissions').applyQuizSubmission = (...args) => mod.applyQuizSubmission(...args)
const queueQuizSubmission: typeof import('./quiz-submissions').queueQuizSubmission = (...args) => mod.queueQuizSubmission(...args)
const dismissQuizSubmission: typeof import('./quiz-submissions').dismissQuizSubmission = (...args) => mod.dismissQuizSubmission(...args)
const getWaitingQuizzes: typeof import('./quiz-submissions').getWaitingQuizzes = (...args) => mod.getWaitingQuizzes(...args)

const QUESTIONS = [
  { question_type: 'true_false', question_text: 'BFS uses a queue.', correct_answer: true, points: 1 },
  { question_type: 'short_answer', question_text: 'Why?', sample_answer: 'x', key_points: ['x'], points: 2 },
]
const GRADING = {
  overall_score: 100,
  earned_points: 3,
  total_points: 3,
  graded_questions: [
    { question_index: 0, question_type: 'true_false', points_possible: 1, points_earned: 1, is_correct: true, feedback: 'Correct!', needs_review: false },
    { question_index: 1, question_type: 'short_answer', points_possible: 2, points_earned: 2, is_correct: true, feedback: 'Good.', needs_review: false, criteria: [] },
  ],
}

async function world() {
  const user = await prisma.user.create({ data: { email: `qs-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  return { user, project, topic }
}

async function gradedSubmission(w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown> = {}) {
  return prisma.quizSubmission.create({
    data: {
      userId: w.user.id,
      topicId: w.topic.id,
      answers: { '0': 'true', '1': 'text' },
      questions: QUESTIONS,
      status: 'graded',
      aiGrading: GRADING,
      gradedAt: new Date(),
      submittedAt: new Date(Date.now() - 3 * 24 * 3600_000),
      ...extra,
    },
  })
}

const effects = async (w: Awaited<ReturnType<typeof world>>) => ({
  attempts: await prisma.quizAttempt.count({ where: { topicId: w.topic.id } }),
  signals: await prisma.learningSignal.count({ where: { topicId: w.topic.id, source: 'quiz' } }),
  schedules: await prisma.reviewSchedule.count({ where: { topicId: w.topic.id } }),
  progress: await prisma.topicProgress.findFirst({ where: { topicId: w.topic.id }, select: { quizCompleted: true, quizScore: true } }),
})

/** Makes writes to this user's review schedule fail, until the returned function is called. */
async function breakReviewSchedule(userId: string) {
  const name = `qs_fail_${userId.replace(/-/g, '')}`
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'review schedule write refused'; END; $$ LANGUAGE plpgsql`
  )
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON review_schedules FOR EACH ROW WHEN (NEW.user_id = '${userId}') EXECUTE FUNCTION ${name}()`
  )
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON review_schedules`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`)
  }
}

dbTest('applying a graded quiz stores the attempt and every effect, stamped with the submit time', async () => {
  const w = await world()
  const submission = await gradedSubmission(w)

  const applied = await applyQuizSubmission(w.user.id, submission.id)

  assert.equal(applied?.score, 100)
  assert.deepEqual(await effects(w), { attempts: 1, signals: 1, schedules: 1, progress: { quizCompleted: true, quizScore: 100 } })
  const attempt = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: submission.id } })
  assert.equal(attempt.takenAt.getTime(), submission.submittedAt.getTime())
  const signal = await prisma.learningSignal.findFirstOrThrow({ where: { topicId: w.topic.id } })
  assert.equal(signal.createdAt.getTime(), submission.submittedAt.getTime())
  // The review date counts from when the student gets the result, not from the day of the quiz.
  const schedule = await prisma.reviewSchedule.findFirstOrThrow({ where: { topicId: w.topic.id } })
  assert.ok(schedule.dueAt.getTime() > Date.now())
  assert.ok(Date.now() - schedule.lastReviewedAt!.getTime() < 60_000)
  assert.ok((await prisma.quizSubmission.findUniqueOrThrow({ where: { id: submission.id } })).appliedAt)
})

dbTest('a failure part way through leaves nothing behind, and the retry applies it exactly once', async () => {
  const w = await world()
  const submission = await gradedSubmission(w)
  const repair = await breakReviewSchedule(w.user.id)
  try {
    await assert.rejects(applyQuizSubmission(w.user.id, submission.id), /review schedule write refused/)
  } finally {
    await repair()
  }
  // The attempt, the signal and the progress went with the failed transaction: not "applied".
  assert.deepEqual(await effects(w), { attempts: 0, signals: 0, schedules: 0, progress: null })
  assert.equal((await prisma.quizSubmission.findUniqueOrThrow({ where: { id: submission.id } })).appliedAt, null)

  assert.ok(await applyQuizSubmission(w.user.id, submission.id))
  assert.deepEqual(await effects(w), { attempts: 1, signals: 1, schedules: 1, progress: { quizCompleted: true, quizScore: 100 } })
  // Looking again changes nothing.
  assert.ok(await applyQuizSubmission(w.user.id, submission.id))
  assert.deepEqual(await effects(w), { attempts: 1, signals: 1, schedules: 1, progress: { quizCompleted: true, quizScore: 100 } })
})

dbTest('two looks at the same time apply it once', async () => {
  const w = await world()
  const submission = await gradedSubmission(w)

  const results = await Promise.all([
    applyQuizSubmission(w.user.id, submission.id),
    applyQuizSubmission(w.user.id, submission.id),
    applyQuizSubmission(w.user.id, submission.id),
  ])

  assert.ok(results.every((result) => result?.attemptId === submission.id))
  assert.deepEqual(await effects(w), { attempts: 1, signals: 1, schedules: 1, progress: { quizCompleted: true, quizScore: 100 } })
})

dbTest('the sweep applies what an earlier failure left unapplied, and only this student\'s', async () => {
  const w = await world()
  const other = await world()
  const mine = await gradedSubmission(w)
  const theirs = await gradedSubmission(other)
  const waiting = await gradedSubmission(w, { status: 'pending', aiGrading: undefined, gradedAt: null })

  const repair = await breakReviewSchedule(w.user.id)
  try {
    assert.equal(await applyPendingQuizResults(w.user.id), 0)
  } finally {
    await repair()
  }
  assert.equal((await effects(w)).attempts, 0)

  // Nothing is held over from the failed try: the next sweep takes it.
  assert.equal(await applyPendingQuizResults(w.user.id, 'all'), 1)
  assert.deepEqual(await effects(w), { attempts: 1, signals: 1, schedules: 1, progress: { quizCompleted: true, quizScore: 100 } })
  assert.ok((await prisma.quizSubmission.findUniqueOrThrow({ where: { id: mine.id } })).appliedAt)
  // Not graded yet: untouched. Someone else's: untouched.
  assert.equal((await prisma.quizSubmission.findUniqueOrThrow({ where: { id: waiting.id } })).appliedAt, null)
  assert.equal((await prisma.quizSubmission.findUniqueOrThrow({ where: { id: theirs.id } })).appliedAt, null)
  assert.equal(await applyPendingQuizResults(w.user.id), 0)
})

dbTest('the same answers submitted at once are one stored submission and one grading job', async () => {
  const w = await world()
  const input = { userId: w.user.id, topic: w.topic, quizSetId: null, questions: QUESTIONS, answers: { '0': 'true', '1': 'a' } }

  const [a, b, c] = await Promise.all([queueQuizSubmission(input), queueQuizSubmission(input), queueQuizSubmission({ ...input, answers: { '1': 'a', '0': 'true' } })])

  assert.equal(a.submissionId, b.submissionId)
  assert.equal(a.submissionId, c.submissionId)
  assert.equal(await prisma.quizSubmission.count({ where: { topicId: w.topic.id } }), 1)
  assert.equal(await prisma.processingJob.count({ where: { targetKey: `grade-quiz:${a.submissionId}` } }), 1)
  // Different answers are another submission.
  const other = await queueQuizSubmission({ ...input, answers: { '0': 'false' } })
  assert.notEqual(other.submissionId, a.submissionId)
})

dbTest('when the AI service cannot be reached the job stays pending for the reaper, not failed', async () => {
  const w = await world()
  const queued = await queueQuizSubmission({ userId: w.user.id, topic: w.topic, quizSetId: null, questions: QUESTIONS, answers: { '0': 'true' } })

  assert.equal(queued.started, true)
  const job = await prisma.processingJob.findFirstOrThrow({ where: { targetKey: `grade-quiz:${queued.submissionId}` } })
  assert.equal(job.status, 'pending')
  assert.equal(job.startedAt, null)
  assert.equal(job.errorCode, null)
  // The page shows it as being graded, not as a failure.
  const [item] = await getWaitingQuizzes(w.user.id, w.topic.id)
  assert.equal(item.state, 'grading')
})

dbTest('a stored quiz can be dismissed once its grading failed, never while it is waiting', async () => {
  const w = await world()
  const queued = await queueQuizSubmission({ userId: w.user.id, topic: w.topic, quizSetId: null, questions: QUESTIONS, answers: { '0': 'true' } })

  assert.equal(await dismissQuizSubmission(w.user.id, w.topic.id, queued.submissionId), 'busy')
  assert.equal(await dismissQuizSubmission((await world()).user.id, w.topic.id, queued.submissionId), 'not_found')

  await prisma.processingJob.updateMany({
    where: { targetKey: `grade-quiz:${queued.submissionId}` },
    data: { status: 'failed', errorCode: 'LLM_CREDIT_EXHAUSTED', completedAt: new Date() },
  })
  assert.equal(await dismissQuizSubmission(w.user.id, w.topic.id, queued.submissionId), 'deleted')
  assert.equal(await prisma.quizSubmission.count({ where: { id: queued.submissionId } }), 0)
  assert.equal(await dismissQuizSubmission(w.user.id, w.topic.id, queued.submissionId), 'not_found')
})

test.after(async () => {
  if (!available) return
  await prisma.$disconnect()
})

dbTest('applying a quiz with concepts writes level-0 evidence with the confidence, once', async () => {
  const w = await world()
  const concept = await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic.id, name: 'Queues', summary: 'BFS uses a queue.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
  })
  const submission = await gradedSubmission(w, {
    answers: { '0': { answer: 'true', confidence: 0.75 }, '1': { answer: 'text', thinking: 'because' } },
    questions: QUESTIONS.map((question) => ({ ...question, concept_ids: [concept.id, 'a-concept-that-is-gone'] })),
  })

  await applyQuizSubmission(w.user.id, submission.id)
  await applyQuizSubmission(w.user.id, submission.id)

  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id }, orderBy: { itemKey: 'asc' } })
  assert.equal(events.length, 2)
  assert.deepEqual(events.map((e) => [e.itemKey, e.source, e.assistance, e.gradedBy, e.sessionKey]), [
    ['quiz:legacy:0', 'quiz', 0, 'rule', `quiz:${submission.id}`],
    ['quiz:legacy:1', 'quiz', 0, 'model', `quiz:${submission.id}`],
  ])
  assert.equal(events[0].confidence, 0.75)
  assert.equal(events[1].confidence, null)
  assert.equal((events[1].metadata as Record<string, unknown>).questionType, 'short_answer')
  // The attempt keeps the plain answers the review list reads.
  const attempt = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: submission.id } })
  assert.deepEqual(attempt.answers, { '0': 'true', '1': 'text' })
})

dbTest('a submission stored with plain string answers applies as before', async () => {
  const w = await world()
  const submission = await gradedSubmission(w)
  const applied = await applyQuizSubmission(w.user.id, submission.id)
  assert.deepEqual(applied?.answers, { '0': 'true', '1': 'text' })
})

dbTest('quiz evidence that failed to write is kept with the attempt and written on the next visit', async () => {
  const { failEvidenceWrites } = await import('./evidence-test-support')
  const w = await world()
  const concept = await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic.id, name: 'Queues', summary: 'BFS uses a queue.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
  })
  const submission = await gradedSubmission(w, {
    answers: { '0': { answer: 'true', confidence: 0.75 }, '1': { answer: 'text' } },
    questions: QUESTIONS.map((question) => ({ ...question, concept_ids: [concept.id] })),
  })

  const restore = await failEvidenceWrites(prisma, w.user.id)
  try {
    // The result is not taken away by the failed write.
    assert.equal((await applyQuizSubmission(w.user.id, submission.id))?.score, 100)
  } finally {
    await restore()
  }
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)
  const owed = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: submission.id } })
  assert.equal(owed.evidenceRecordedAt, null)
  assert.ok(owed.evidencePending)

  // Any visit that applies results writes what is owed first (an hour after the failed try), once, and clears the copy.
  await prisma.quizAttempt.update({ where: { id: submission.id }, data: { evidenceTriedAt: new Date(Date.now() - 2 * 3600_000) } })
  await applyPendingQuizResults(w.user.id)
  await applyPendingQuizResults(w.user.id)
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id }, orderBy: { itemKey: 'asc' } })
  assert.deepEqual(events.map((e) => [e.itemKey, e.confidence]), [['quiz:legacy:0', 0.75], ['quiz:legacy:1', null]])
  const done = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: submission.id } })
  assert.ok(done.evidenceRecordedAt)
  assert.equal(done.evidencePending, null)
})

dbTest('an attempt whose evidence was written is marked, with no copy kept', async () => {
  const w = await world()
  const concept = await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic.id, name: 'Queues', summary: 'BFS uses a queue.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
  })
  const submission = await gradedSubmission(w, { questions: QUESTIONS.map((question) => ({ ...question, concept_ids: [concept.id] })) })
  await applyQuizSubmission(w.user.id, submission.id)
  const attempt = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: submission.id } })
  assert.ok(attempt.evidenceRecordedAt)
  assert.equal(attempt.evidencePending, null)
  // A quiz with no concepts keeps nothing either.
  const plain = await gradedSubmission(w)
  await applyQuizSubmission(w.user.id, plain.id)
  const plainAttempt = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: plain.id } })
  assert.equal(plainAttempt.evidencePending, null)
})

dbTest('quiz evidence is tried at most once an hour and given up on after the cap', async () => {
  const { failEvidenceWrites } = await import('./evidence-test-support')
  const { EVIDENCE_MAX_ATTEMPTS } = await import('./evidence-retry-budget')
  const w = await world()
  const concept = await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic.id, name: 'Queues', summary: 'BFS uses a queue.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
  })
  const submission = await gradedSubmission(w, { questions: QUESTIONS.map((question) => ({ ...question, concept_ids: [concept.id] })) })
  const backdate = () =>
    prisma.quizAttempt.update({ where: { id: submission.id }, data: { evidenceTriedAt: new Date(Date.now() - 2 * 3600_000) } })
  const attempts = async () => (await prisma.quizAttempt.findUniqueOrThrow({ where: { id: submission.id } })).evidenceAttempts

  const restore = await failEvidenceWrites(prisma, w.user.id)
  try {
    await applyQuizSubmission(w.user.id, submission.id)
    assert.equal(await attempts(), 1)
    // Within the hour nothing is tried.
    await applyPendingQuizResults(w.user.id)
    assert.equal(await attempts(), 1)
    for (let i = 1; i < EVIDENCE_MAX_ATTEMPTS; i += 1) {
      await backdate()
      await applyPendingQuizResults(w.user.id)
    }
    assert.equal(await attempts(), EVIDENCE_MAX_ATTEMPTS)
  } finally {
    await restore()
  }
  // Given up on: a healthy database and an old try still leave it alone.
  await backdate()
  await applyPendingQuizResults(w.user.id)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)
  assert.equal(await attempts(), EVIDENCE_MAX_ATTEMPTS)
})

dbTest('a quiz on a converted topic reports the review date and mastery the concepts give, not the interval rule', async () => {
  const w = await world()
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const concept = await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic.id, name: 'Queues', summary: 'BFS uses a queue.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
  })
  const submission = await gradedSubmission(w, {
    questions: QUESTIONS.map((question) => ({ ...question, concept_ids: [concept.id] })),
    submittedAt: new Date(),
  })

  const applied = await applyQuizSubmission(w.user.id, submission.id)

  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: concept.id } } })
  assert.equal(applied?.outcome.nextReviewAt?.getTime(), memory.dueAt!.getTime())
  assert.ok(Math.abs(applied!.outcome.mastery! - memory.mastery) < 1e-2)
  const schedule = await prisma.reviewSchedule.findFirstOrThrow({ where: { topicId: w.topic.id } })
  assert.equal(schedule.dueAt.getTime(), memory.dueAt!.getTime())
})

dbTest('a waiting quiz for a set already taken earlier the same day is applied at level 2', async () => {
  const w = await world()
  const concept = await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic.id, name: 'Queues', summary: 'BFS uses a queue.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
  })
  const questions = QUESTIONS.map((question) => ({ ...question, concept_ids: [concept.id] }))
  // The same set was taken an hour before this submission, the same day in UTC.
  const submittedAt = new Date()
  submittedAt.setUTCHours(12, 0, 0, 0)
  await prisma.quizAttempt.create({
    data: { userId: w.user.id, topicId: w.topic.id, quizSetId: null, answers: {}, results: {}, score: 50, takenAt: new Date(submittedAt.getTime() - 3_600_000) },
  })
  const submission = await gradedSubmission(w, { questions, submittedAt })
  await applyQuizSubmission(w.user.id, submission.id)
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'quiz' } })
  assert.ok(events.length > 0)
  for (const event of events) {
    assert.equal(event.assistance, 2)
    assert.equal((event.metadata as Record<string, unknown>).repeat, 'same_day')
  }
})

/** A graded submission of two true/false questions that are both right, with the given answers (and so the given confidence). */
const strongSubmission = (w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown> = {}) =>
  gradedSubmission(w, {
    questions: [QUESTIONS[0], { ...QUESTIONS[0], question_text: 'DFS uses a stack.' }],
    answers: { '0': { answer: 'true', confidence: 0.95, confidenceLevel: 'certain' }, '1': { answer: 'true', confidence: 0.75, confidenceLevel: 'fairly' } },
    aiGrading: {
      overall_score: 100,
      earned_points: 2,
      total_points: 2,
      graded_questions: [
        { question_index: 0, question_type: 'true_false', points_possible: 1, points_earned: 1, is_correct: true, feedback: '', needs_review: false },
        { question_index: 1, question_type: 'true_false', points_possible: 1, points_earned: 1, is_correct: true, feedback: '', needs_review: false },
      ],
    },
    ...extra,
  })

const testedOutAt = async (w: Awaited<ReturnType<typeof world>>) =>
  (await prisma.topicProgress.findFirst({ where: { topicId: w.topic.id, userId: w.user.id }, select: { testedOutAt: true } }))?.testedOutAt ?? null

dbTest('strong first quiz sets testedOutAt', async () => {
  const w = await world()
  const submission = await strongSubmission(w)
  await applyQuizSubmission(w.user.id, submission.id)
  assert.ok(await testedOutAt(w))

  // A quiz under the bar leaves testedOutAt empty.
  const under = await world()
  const underSubmission = await gradedSubmission(under, {
    questions: [QUESTIONS[0], QUESTIONS[0]],
    answers: { '0': 'true', '1': 'false' },
    aiGrading: {
      overall_score: 50,
      earned_points: 1,
      total_points: 2,
      graded_questions: [
        { question_index: 0, question_type: 'true_false', points_possible: 1, points_earned: 1, is_correct: true, feedback: '', needs_review: false },
        { question_index: 1, question_type: 'true_false', points_possible: 1, points_earned: 0, is_correct: false, feedback: '', needs_review: false },
      ],
    },
  })
  await applyQuizSubmission(under.user.id, underSubmission.id)
  assert.equal(await testedOutAt(under), null)

  // Guessed right answers do not count for testedOut.
  const guessed = await world()
  const guessedSubmission = await strongSubmission(guessed, {
    answers: { '0': { answer: 'true', confidence: 0.5, confidenceLevel: 'guess' }, '1': { answer: 'true', confidence: 0.5, confidenceLevel: 'guess' } },
  })
  await applyQuizSubmission(guessed.user.id, guessedSubmission.id)
  assert.equal(await testedOutAt(guessed), null)
})

dbTest('testedOut not set after recall', async () => {
  const w = await world()
  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, recallAt: new Date(Date.now() - 86_400_000) } })
  const submission = await strongSubmission(w)
  await applyQuizSubmission(w.user.id, submission.id)
  assert.equal(await testedOutAt(w), null)
})

dbTest('a retry set or a same-day repeat does not test out', async () => {
  const retry = await world()
  const retrySet = await prisma.topicQuiz.create({ data: { topicId: retry.topic.id, kind: 'retry', questions: QUESTIONS } })
  await applyQuizSubmission(retry.user.id, (await strongSubmission(retry, { quizSetId: retrySet.id })).id)
  assert.equal(await testedOutAt(retry), null)

  const repeat = await world()
  const submittedAt = new Date()
  submittedAt.setUTCHours(12, 0, 0, 0)
  await prisma.quizAttempt.create({ data: { userId: repeat.user.id, topicId: repeat.topic.id, quizSetId: null, answers: {}, results: {}, score: 20, takenAt: new Date(submittedAt.getTime() - 3_600_000) } })
  await applyQuizSubmission(repeat.user.id, (await strongSubmission(repeat, { submittedAt })).id)
  assert.equal(await testedOutAt(repeat), null)
})

dbTest('a strong quiz kept testedOutAt from the first time', async () => {
  const w = await world()
  const first = new Date(Date.now() - 5 * 86_400_000)
  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, testedOutAt: first } })
  await applyQuizSubmission(w.user.id, (await strongSubmission(w)).id)
  assert.equal((await testedOutAt(w))?.getTime(), first.getTime())
})

// ---- AI down: the rule-graded items are graded and recorded at once (spec 18.9) ----

const PARTIAL_QUESTIONS = (conceptId: string) => [
  { question_type: 'true_false', question_text: 'BFS uses a queue.', correct_answer: true, points: 1, concept_ids: [conceptId] },
  { question_type: 'short_answer', question_text: 'Why?', sample_answer: 'x', key_points: ['x'], points: 2, concept_ids: [conceptId] },
]
const ruleGraded = (correct: boolean) => ({
  graded_questions: [{ question_index: 0, question_type: 'true_false', points_possible: 1, points_earned: correct ? 1 : 0, is_correct: correct, feedback: '', needs_review: false }],
  total_points: 1,
  earned_points: correct ? 1 : 0,
  overall_score: correct ? 100 : 0,
  needs_review: false,
})

async function partialWorld() {
  const w = await world()
  const concept = await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.topic.id, name: 'Queues', summary: 'BFS uses a queue.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
  })
  const questions = PARTIAL_QUESTIONS(concept.id)
  const given = { '0': { answer: 'true', confidence: 0.75 }, '1': { answer: 'because of the queue' } }
  return { w, concept, questions, given }
}

dbTest('rule items graded while short answers wait', async () => {
  const { w, questions, given } = await partialWorld()
  const asked: number[][] = []
  const grade = async (_questions: unknown[], _answers: unknown, only?: number[]) => {
    asked.push(only ?? [])
    return ruleGraded(true)
  }
  const partial = await mod.gradeRuleItemsNow({
    userId: w.user.id,
    topic: w.topic,
    quizSetId: null,
    questions,
    given,
    unavailableCode: 'LLM_CREDIT_EXHAUSTED',
    timeZone: 'UTC',
    sameDayRepeat: false,
    grade,
  })
  assert.ok(partial)
  // Only the rule-gradable question was sent to the grader.
  assert.deepEqual(asked, [[0]])
  assert.deepEqual({ correct: partial.summary.correct, total: partial.summary.total, waiting: partial.summary.waiting }, { correct: 1, total: 1, waiting: 1 })

  const row = await prisma.quizSubmission.findUniqueOrThrow({ where: { id: partial.submission.submissionId } })
  assert.equal(row.status, 'pending')
  assert.ok(row.ruleGradedAt)
  assert.equal((row.ruleResults as unknown[]).length, 1)
  // No attempt, no score: nothing partial reaches mastery or the history.
  assert.equal(await prisma.quizAttempt.count({ where: { topicId: w.topic.id } }), 0)
  // The rule item's evidence is written now, under the submission's session key.
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.deepEqual(events.map((e) => [e.itemKey, e.source, e.assistance, e.sessionKey]), [['quiz:legacy:0', 'quiz', 0, `quiz:${row.id}`]])
  assert.equal(events[0].confidence, 0.75)

  // The waiting list carries the partial result.
  const waiting = await getWaitingQuizzes(w.user.id, w.topic.id)
  assert.equal(waiting.length, 1)
  assert.deepEqual(waiting[0].partial?.summary, { correct: 1, total: 1, waiting: 1 })
  assert.equal(waiting[0].partial?.review.length, 1)
  assert.equal(waiting[0].partial?.review[0].questionIndex, 0)
})

dbTest('rule item evidence written once across the partial and the final apply', async () => {
  const { w, questions, given } = await partialWorld()
  const partial = await mod.gradeRuleItemsNow({
    userId: w.user.id,
    topic: w.topic,
    quizSetId: null,
    questions,
    given,
    unavailableCode: null,
    timeZone: 'UTC',
    sameDayRepeat: false,
    grade: async () => ruleGraded(true),
  })
  assert.ok(partial)
  const id = partial.submission.submissionId
  const before = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.equal(before.length, 1)

  // The job grades the whole stored quiz; the short answer is the only new thing, and the rule item keeps its one event.
  await prisma.quizSubmission.update({
    where: { id },
    data: {
      status: 'graded',
      gradedAt: new Date(),
      aiGrading: {
        overall_score: 100,
        earned_points: 3,
        total_points: 3,
        graded_questions: [
          ...ruleGraded(true).graded_questions,
          { question_index: 1, question_type: 'short_answer', points_possible: 2, points_earned: 2, is_correct: true, feedback: 'Good.', needs_review: false },
        ],
      },
    },
  })
  const applied = await applyQuizSubmission(w.user.id, id)
  assert.equal(applied?.score, 100)
  await applyQuizSubmission(w.user.id, id)
  const after = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id }, orderBy: { itemKey: 'asc' } })
  assert.deepEqual(after.map((e) => [e.itemKey, e.gradedBy, e.sessionKey]), [
    ['quiz:legacy:0', 'rule', `quiz:${id}`],
    ['quiz:legacy:1', 'model', `quiz:${id}`],
  ])
  assert.equal(after[0].id, before[0].id)
})

dbTest('unreachable service still queues the whole quiz', async () => {
  const { w, questions, given } = await partialWorld()
  let called = 0
  const base = { userId: w.user.id, topic: w.topic, quizSetId: null, questions, given, timeZone: 'UTC', sameDayRepeat: false }
  // The service is not there at all: the grader is not even asked.
  assert.equal(
    await mod.gradeRuleItemsNow({ ...base, unavailableCode: 'AI_UNREACHABLE', grade: async () => { called += 1; return ruleGraded(true) } }),
    null
  )
  assert.equal(called, 0)
  // It was reachable a moment ago and is not now.
  const { GradingUnavailableError } = await import('@/lib/ai-service/grading')
  assert.equal(
    await mod.gradeRuleItemsNow({ ...base, unavailableCode: 'LLM_CREDIT_EXHAUSTED', grade: async () => { throw new GradingUnavailableError(undefined, 'AI_UNREACHABLE') } }),
    null
  )
  // Nothing was stored by either attempt.
  assert.equal(await prisma.quizSubmission.count({ where: { topicId: w.topic.id } }), 0)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)
})

dbTest('a quiz with no rule-gradable question has nothing to grade early', async () => {
  const { w, concept, given } = await partialWorld()
  const onlyShort = [PARTIAL_QUESTIONS(concept.id)[1]]
  const result = await mod.gradeRuleItemsNow({
    userId: w.user.id,
    topic: w.topic,
    quizSetId: null,
    questions: onlyShort,
    given: { '0': given['1'] },
    unavailableCode: 'LLM_CREDIT_EXHAUSTED',
    timeZone: 'UTC',
    sameDayRepeat: false,
    grade: async () => ruleGraded(true),
  })
  assert.equal(result, null)
})
