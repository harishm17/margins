import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { applyScreenSize, shot } from './helpers/v31-sessions'
import { addContent, addMaterial, createCourse, createEmptyCourse, signIn } from './helpers/loop'

// A topic quiz submitted while the AI is unavailable is stored, its short answers wait for the AI like
// an exam's do, and it is graded and applied (mastery, review date, plan) once the AI is back.
// The mock LLM fails like the real API when out of credit if an answer carries MOCK_LLM_FAIL.

// Each test signs in as its own account: the learning-loop specs share one, and a course made here would change what Home continues.
const markAvailable = () => withPrisma((prisma) => prisma.aiStatus.deleteMany({}))

test.beforeEach(async ({ page }) => applyScreenSize(page))

test.afterEach(async () => {
  // A test that held the grading job must not leave the gate shut for the next one.
  await rm(join(process.env.E2E_RUN_DIR || join(process.cwd(), '..', '.e2e'), 'hold', 'grade_quiz.hold'), { force: true })
  await markAvailable()
})

test('quiz: submitted during an outage, the answers are saved and graded once AI is back', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, `quizwait-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`)
  const courseId = await createEmptyCourse(page, 'Quiz wait course')
  await addMaterial(page, courseId)
  const course = await createCourse(page, 'Quiz wait course', [{ name: 'Graph traversal', minutes: 30 }], { existingCourseId: courseId })
  const topic = course.topics['Graph traversal']
  await addContent(topic, {
    section_notes: '# Graph traversal\n\nNotes.',
    topic_quiz: [
      { question_type: 'true_false', question_text: 'BFS uses a queue.', correct_answer: true, explanation: 'It does.', points: 1 },
      {
        question_type: 'short_answer',
        question_text: 'Why does BFS find shortest paths?',
        sample_answer: 'It visits nodes in order of distance.',
        key_points: ['level order'],
        points: 2,
      },
    ],
  })

  await page.goto(`/courses/${courseId}/topics/${topic}?view=quiz`)
  await page.getByRole('button', { name: /^(Start|Take)/ }).first().click()
  await expect(page.getByText('Question 1 of 2').locator('visible=true')).toBeVisible()
  await page.keyboard.press('t')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  // The first grading call fails as out of credit; the next works (the outage is over).
  const trigger = `MOCK_LLM_FAIL:LLM_CREDIT_EXHAUSTEDx1@quiz${Date.now()}`
  await page.getByLabel('Your answer').locator('visible=true').fill(`Queue gives level order. ${trigger}`)
  await page.getByRole('button', { name: 'Submit quiz' }).click()

  // The honest waiting state, the one an exam shows.
  await expect(page.getByRole('heading', { name: 'Your answers are saved' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Grading will finish when AI is available again.')).toBeVisible()

  const stored = await withPrisma(async (prisma) => ({
    submission: await prisma.quizSubmission.findFirstOrThrow({ where: { topicId: topic }, select: { id: true, status: true, answers: true } }),
    attempts: await prisma.quizAttempt.count({ where: { topicId: topic } }),
    progress: await prisma.topicProgress.findFirst({ where: { topicId: topic }, select: { quizCompleted: true } }),
    schedules: await prisma.reviewSchedule.count({ where: { topicId: topic } }),
    aiStatus: await prisma.aiStatus.findUnique({ where: { id: 'global' } }),
  }))
  expect(stored.submission.status).toBe('pending')
  expect(Object.keys(stored.submission.answers as object)).toEqual(['0', '1'])
  // Nothing partial reaches the history, the plan's "quiz done" or the review date.
  expect(stored.attempts).toBe(0)
  expect(stored.progress?.quizCompleted ?? false).toBe(false)
  expect(stored.schedules).toBe(0)
  expect(stored.aiStatus?.state).toBe('unavailable')
  const waiting = await withPrisma((prisma) =>
    prisma.processingJob.findFirstOrThrow({
      where: { jobType: 'grade_quiz', targetKey: `grade-quiz:${stored.submission.id}` },
      select: { status: true, stage: true, attemptCount: true },
    })
  )
  expect(waiting).toEqual({ status: 'pending', stage: 'waiting_for_ai', attemptCount: 0 })

  // Leaving and coming back still shows it waiting (not the lobby alone, not a lost quiz).
  await page.goto(`/courses/${courseId}/topics/${topic}?view=quiz`)
  await expect(page.getByRole('heading', { name: 'Your answers are saved' })).toBeVisible()

  // The outage ends the natural way, as it does for a student: only the shared status clears, and the job's own recheck
  // lease (30 s) and the reaper (5 s in the e2e stack) bring the results back by themselves, within the long wait below.
  await markAvailable()
  await expect(page.getByRole('heading', { name: /of 3 points/ })).toBeVisible({ timeout: 150_000 })

  const done = await withPrisma(async (prisma) => ({
    submission: await prisma.quizSubmission.findUniqueOrThrow({ where: { id: stored.submission.id }, select: { status: true, appliedAt: true } }),
    job: await prisma.processingJob.findFirstOrThrow({ where: { targetKey: `grade-quiz:${stored.submission.id}` }, select: { status: true } }),
    attempts: await prisma.quizAttempt.findMany({ where: { topicId: topic }, select: { id: true } }),
    progress: await prisma.topicProgress.findFirstOrThrow({ where: { topicId: topic }, select: { quizCompleted: true } }),
    signals: await prisma.learningSignal.count({ where: { topicId: topic, source: 'quiz' } }),
    schedules: await prisma.reviewSchedule.count({ where: { topicId: topic } }),
  }))
  expect(done.job.status).toBe('completed')
  expect(done.submission.status).toBe('graded')
  expect(done.submission.appliedAt).not.toBeNull()
  // One attempt (the submission's own id), applied once: one signal, one schedule, quiz done.
  expect(done.attempts).toEqual([{ id: stored.submission.id }])
  expect(done.progress.quizCompleted).toBe(true)
  expect(done.signals).toBe(1)
  expect(done.schedules).toBe(1)

  // Looking again (a reload, another page) does not apply it twice.
  await page.reload()
  await page.goto(`/courses/${courseId}/plan`)
  expect(await withPrisma((prisma) => prisma.learningSignal.count({ where: { topicId: topic, source: 'quiz' } }))).toBe(1)
})

test('quiz: a waiting quiz whose grading did not finish offers Grade again', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, `quizwait-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`)
  const courseId = await createEmptyCourse(page, 'Quiz expiry course')
  await addMaterial(page, courseId)
  const course = await createCourse(page, 'Quiz expiry course', [{ name: 'Hashing', minutes: 30 }], { existingCourseId: courseId })
  const topic = course.topics['Hashing']
  const questions = [
    {
      question_type: 'short_answer',
      question_text: 'Why hash?',
      sample_answer: 'Fast lookup.',
      key_points: ['lookup'],
      points: 2,
    },
  ]
  await addContent(topic, { section_notes: '# Hashing\n\nNotes.', topic_quiz: questions })

  // A submission whose seven-day wait ran out (its job failed with the reason it waited for).
  const userId = (await withPrisma((prisma) => prisma.project.findUniqueOrThrow({ where: { id: courseId }, select: { userId: true } }))).userId
  const submission = await withPrisma(async (prisma) => {
    const row = await prisma.quizSubmission.create({ data: { userId, topicId: topic, answers: { '0': 'Fast lookup.' }, questions } })
    await prisma.processingJob.create({
      data: {
        userId,
        projectId: courseId,
        jobType: 'grade_quiz',
        status: 'failed',
        stage: 'waiting_for_ai',
        errorCode: 'LLM_CREDIT_EXHAUSTED',
        retryable: true,
        targetKey: `grade-quiz:${row.id}`,
        completedAt: new Date(),
      },
    })
    return row
  })

  await page.goto(`/courses/${courseId}/topics/${topic}?view=quiz`)
  const alert = page.getByRole('alert').filter({ hasText: "Grading didn't finish" })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('Your answers are saved.')

  // Grade again starts a new job for the same submission, and the mock (AI available) grades it.
  await alert.getByRole('button', { name: 'Grade again' }).click()
  await expect(page.getByRole('heading', { name: /of 2 points/ })).toBeVisible({ timeout: 120_000 })
  const jobs = await withPrisma((prisma) => prisma.processingJob.count({ where: { targetKey: `grade-quiz:${submission.id}` } }))
  expect(jobs).toBe(2)
})

test('quiz: a card for a grading that did not finish can be dismissed, which removes the stored answers', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, `quizwait-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`)
  const courseId = await createEmptyCourse(page, 'Quiz dismiss course')
  await addMaterial(page, courseId)
  const course = await createCourse(page, 'Quiz dismiss course', [{ name: 'Sorting', minutes: 30 }], { existingCourseId: courseId })
  const topic = course.topics['Sorting']
  const questions = [{ question_type: 'short_answer', question_text: 'Why sort?', sample_answer: 'Order.', key_points: ['order'], points: 2 }]
  await addContent(topic, { section_notes: '# Sorting\n\nNotes.', topic_quiz: questions })
  const userId = (await withPrisma((prisma) => prisma.project.findUniqueOrThrow({ where: { id: courseId }, select: { userId: true } }))).userId
  const submission = await withPrisma(async (prisma) => {
    const row = await prisma.quizSubmission.create({ data: { userId, topicId: topic, answers: { '0': 'Order.' }, questions } })
    await prisma.processingJob.create({
      data: {
        userId,
        projectId: courseId,
        jobType: 'grade_quiz',
        status: 'failed',
        stage: 'waiting_for_ai',
        errorCode: 'LLM_CREDIT_EXHAUSTED',
        targetKey: `grade-quiz:${row.id}`,
        completedAt: new Date(),
      },
    })
    return row
  })

  await page.goto(`/courses/${courseId}/topics/${topic}?view=quiz`)
  const alert = page.getByRole('alert').filter({ hasText: "Grading didn't finish" })
  await expect(alert).toBeVisible()
  await alert.getByRole('button', { name: 'Dismiss' }).click()
  await expect(alert).toBeHidden()
  expect(await withPrisma((prisma) => prisma.quizSubmission.count({ where: { id: submission.id } }))).toBe(0)
  await page.reload()
  await expect(page.getByRole('alert').filter({ hasText: "Grading didn't finish" })).toHaveCount(0)
})

test('AI down shows multiple choice results at once', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, `quizwait-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`)
  const courseId = await createEmptyCourse(page, 'Quiz partial course')
  await addMaterial(page, courseId)
  const course = await createCourse(page, 'Quiz partial course', [{ name: 'Graph traversal', minutes: 30 }], { existingCourseId: courseId })
  const topic = course.topics['Graph traversal']
  // With notes the topic page does not start preparing the topic: a second quiz set made meanwhile would replace this one as the newest.
  await addContent(topic, { section_notes: '# Graph traversal\n\nBFS uses a queue.' })
  const concept = await withPrisma(async (prisma) => {
    const row = await prisma.concept.create({
      data: { projectId: courseId, topicId: topic, name: 'Queues', summary: 'BFS uses a queue.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] },
    })
    await prisma.topic.update({ where: { id: topic }, data: { evidenceBackfilledAt: new Date() } })
    return row.id
  })
  const set = await withPrisma(async (prisma) =>
    prisma.topicQuiz.create({
      data: {
        topicId: topic,
        questions: [
          { question_type: 'true_false', question_text: 'BFS uses a queue.', correct_answer: true, explanation: 'It does.', points: 1, concept_ids: [concept] },
          { question_type: 'true_false', question_text: 'DFS uses a queue.', correct_answer: false, explanation: 'It uses a stack.', points: 1, concept_ids: [concept] },
          {
            question_type: 'short_answer',
            question_text: 'Why does BFS find shortest paths?',
            sample_answer: 'It visits nodes in order of distance.',
            key_points: ['level order'],
            points: 2,
            concept_ids: [concept],
          },
        ],
      },
    })
  )

  // The grading job is held before it is sent (the stack's E2E_HOLD_DIR hook, src/lib/tasks/dispatch.ts), so the partial view stays
  // until this test lets it go, whatever the AI status does meanwhile.
  const holdDir = join(process.env.E2E_RUN_DIR || join(process.cwd(), '..', '.e2e'), 'hold')
  const gate = join(holdDir, 'grade_quiz.hold')
  await mkdir(holdDir, { recursive: true })
  await writeFile(gate, '')

  await page.goto(`/courses/${courseId}/topics/${topic}?view=quiz`)
  await page.getByRole('button', { name: 'Start quiz' }).click()
  // Question 1 right, question 2 wrong (true instead of false), question 3 a short answer the AI cannot grade now.
  await page.getByRole('radio', { name: 'True' }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByRole('radio', { name: 'True' }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  const trigger = `MOCK_LLM_FAIL:LLM_CREDIT_EXHAUSTEDx1@partial${Date.now()}`
  await page.getByLabel('Your answer').locator('visible=true').fill(`Queue gives level order. ${trigger}`)
  await page.getByRole('button', { name: 'Submit quiz' }).click()

  // The multiple choice results are shown at once, with what waits, and no overall score.
  const partial = page.getByTestId('partial-results')
  await expect(partial).toBeVisible({ timeout: 60_000 })
  await expect(partial.getByRole('heading', { name: 'Graded so far' })).toBeVisible()
  await expect(partial).toContainText("1 of 2 multiple choice right. 1 short answer waits for grading; it'll be marked when the AI is back.")
  await expect(partial).toContainText('DFS uses a queue.')
  await expect(page.getByRole('heading', { name: /of \d+ points/ })).toHaveCount(0)
  // Below it, the wait for the short answers (held here, so it reads as grading; with the AI away it reads "Your answers are saved").
  await expect(page.getByRole('heading', { name: /^(Your answers are saved|Grading your quiz)$/ })).toBeVisible()
  await shot(page, 'quiz-partial')

  const stored = await withPrisma(async (prisma) => ({
    submission: await prisma.quizSubmission.findFirstOrThrow({ where: { topicId: topic }, select: { id: true, status: true, ruleGradedAt: true, quizSetId: true } }),
    attempts: await prisma.quizAttempt.count({ where: { topicId: topic } }),
    events: await prisma.evidenceEvent.findMany({ where: { topicId: topic, source: 'quiz' }, select: { id: true, itemKey: true, sessionKey: true, score: true } }),
  }))
  expect(stored.submission.status).toBe('pending')
  expect(stored.submission.ruleGradedAt).not.toBeNull()
  expect(stored.submission.quizSetId).toBe(set.id)
  // No attempt yet, but the two rule items already count, under the submission's session key.
  expect(stored.attempts).toBe(0)
  expect(stored.events.map((event) => [event.itemKey, event.score]).sort()).toEqual([[`quiz:${set.id}:0`, 1], [`quiz:${set.id}:1`, 0]])
  expect(stored.events.every((event) => event.sessionKey === `quiz:${stored.submission.id}`)).toBe(true)

  // The outage ends: the short answer is graded and the full score appears; the rule items keep their one event each.
  const job = await withPrisma((prisma) => prisma.processingJob.findFirstOrThrow({ where: { jobType: 'grade_quiz', targetKey: `grade-quiz:${stored.submission.id}` } }))
  await markAvailable()
  await rm(gate, { force: true })
  await writeFile(join(holdDir, `${job.id}.release`), '')
  await expect(page.getByRole('heading', { name: /of 4 points/ })).toBeVisible({ timeout: 150_000 })
  const done = await withPrisma((prisma) => prisma.evidenceEvent.findMany({ where: { topicId: topic, source: 'quiz' }, select: { id: true, itemKey: true } }))
  expect(done.map((event) => event.itemKey).sort()).toEqual([`quiz:${set.id}:0`, `quiz:${set.id}:1`, `quiz:${set.id}:2`])
  for (const event of stored.events) expect(done.some((later) => later.id === event.id)).toBe(true)
})
