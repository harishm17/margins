import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { DEMO_EMAIL, DEMO_PASSWORD, demoIds } from './helpers/seed-demo'

// The shared AI status (ai-service app/services/ai_status.py) and what students see while AI is
// unavailable. The stack reads the status uncached (scripts/e2e-stack.sh), and every test puts the
// status back to available, so the other specs never see AI as down.
const course = `/courses/${demoIds().course}`
const PAUSED = 'AI features are paused right now. Your files and progress are safe. Try again later.'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(DEMO_EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/home$/, { timeout: 60_000 })
}

const markUnavailable = () =>
  withPrisma((prisma) => {
    const now = new Date()
    const row = { state: 'unavailable', reason: 'LLM_CREDIT_EXHAUSTED', since: now, checkedAt: now, detail: 'e2e' }
    return prisma.aiStatus.upsert({ where: { id: 'global' }, create: { id: 'global', ...row }, update: row })
  })

const markAvailable = () => withPrisma((prisma) => prisma.aiStatus.deleteMany({}))

test.afterEach(async () => {
  await markAvailable()
})

test('while AI is unavailable: a banner on every page, and AI actions are off with the reason', async ({ page }) => {
  await markUnavailable()

  await page.goto('/')
  const banner = page.getByRole('status').filter({ hasText: 'AI features are paused' })
  await expect(banner).toBeVisible()
  await page.goto('/login')
  await expect(banner).toBeVisible()

  await signIn(page)
  await expect(banner).toBeVisible()
  // Closed, it stays closed for the session.
  await banner.getByRole('button', { name: 'Close this notice' }).click()
  await expect(banner).toBeHidden()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await expect(banner).toBeHidden()

  await page.goto(`${course}/exams/new`)
  await expect(page.getByRole('button', { name: 'Create exam' })).toBeDisabled()
  await expect(page.getByText(PAUSED)).toBeVisible()

  await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
  await page.getByLabel('Ask about your materials').fill('What is hashing?')
  await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled()
  await expect(page.getByText(PAUSED)).toBeVisible()

  // The API refuses too, before anything is created, with a typed code and no operator wording.
  const refused = await page.request.post(`/api/projects/${demoIds().course}/generate-exam`, {
    data: { topicIds: ['x'], totalQuestions: 10, durationMinutes: 30, difficultyLevel: 'medium' },
  })
  expect(refused.status()).toBe(503)
  const body = await refused.json()
  expect(body.error.details.code).toBe('LLM_CREDIT_EXHAUSTED')
  expect(body.error.message).not.toMatch(/credit|ANTHROPIC|key/i)

  // Back up: the next check clears it.
  await markAvailable()
  await page.goto(`${course}/exams/new`)
  await expect(page.getByRole('button', { name: 'Create exam' })).toBeEnabled()
})

test('ask: a failed first answer leaves no conversation behind and turns AI off everywhere', async ({ page }) => {
  await signIn(page)
  await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })

  // The mock provider fails like the API when out of credit.
  const question = `What is hashing? MOCK_LLM_FAIL:LLM_CREDIT_EXHAUSTED ${Date.now()}`
  await page.getByLabel('Ask about your materials').fill(question)
  await page.keyboard.press('Enter')

  await expect(page.getByRole('alert').filter({ hasText: PAUSED })).toBeVisible({ timeout: 30_000 })
  // Not saved: no conversation in the list or the address, and none in the database.
  await expect(page).not.toHaveURL(/[?&]thread=/)
  await expect(page.getByRole('link', { name: question.slice(0, 20) })).toHaveCount(0)
  const stored = await withPrisma((prisma) => prisma.chatThread.count({ where: { title: { contains: 'MOCK_LLM_FAIL' } } }))
  expect(stored).toBe(0)

  // The failure marked AI unavailable for everyone: the banner and the composer say so.
  await expect(page.getByRole('status').filter({ hasText: 'AI features are paused' })).toBeVisible()
  await page.getByLabel('Ask about your materials').fill('What is hashing?')
  await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled()
})

test('mock exam: submitted during an outage, the answers are saved and graded once AI is back', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  await page.goto(`${course}/exams/new`)
  await page.getByRole('radio', { name: '10', exact: true }).click()
  await page.getByRole('button', { name: 'Create exam' }).click()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })
  const examId = page.url().split('/').pop()!
  await page.getByRole('button', { name: /^(Start exam|Resume)/ }).click()
  await expect(page).toHaveURL(/\/take$/)

  // Every written answer carries the mock's trigger: the first grading call fails as out of
  // credit, as the real API would during an outage; the next one works (the outage is over).
  const questions = await withPrisma(async (prisma) => {
    const exam = await prisma.sampleExam.findUniqueOrThrow({ where: { id: examId }, select: { questions: true } })
    return exam.questions as Array<{ question_type: string; correct_answer?: unknown }>
  })
  expect(questions.some((q) => q.question_type === 'short_answer')).toBe(true)
  const trigger = `MOCK_LLM_FAIL:LLM_CREDIT_EXHAUSTEDx1@grade${Date.now()}`
  const answers = Object.fromEntries(
    questions.map((q, index) => [String(index), q.question_type === 'short_answer' ? `Caching keeps data close. ${trigger}` : String(q.correct_answer ?? 'A')])
  )
  const submitted = await page.request.post(`/api/exams/${examId}/submit`, { data: { answers } })
  expect(submitted.status()).toBe(200)
  const { submissionId } = await submitted.json()

  await page.goto(`${course}/exams/${examId}/results/${submissionId}`)
  await expect(page.getByRole('heading', { name: 'Your answers are saved' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Grading will finish when AI is available again.')).toBeVisible()
  const waiting = await withPrisma((prisma) =>
    prisma.processingJob.findFirstOrThrow({
      where: { jobType: 'grade_exam', targetKey: `grade:${submissionId}` },
      select: { status: true, stage: true, attemptCount: true },
    })
  )
  expect(waiting).toEqual({ status: 'pending', stage: 'waiting_for_ai', attemptCount: 0 })
  const stored = await withPrisma((prisma) =>
    prisma.examSubmission.findUniqueOrThrow({ where: { id: submissionId }, select: { answers: true, aiGrading: true } })
  )
  expect(stored.answers).toEqual(answers)
  expect(stored.aiGrading).toBeNull()
  // The failure marked AI unavailable for everyone; submitting again now would still be accepted.
  const status = await withPrisma((prisma) => prisma.aiStatus.findUnique({ where: { id: 'global' } }))
  expect(status?.state).toBe('unavailable')

  // The real outage ends (credit topped up): the shared status clears and the reaper sends the
  // grading again; this time the model answers, and the page shows the score by itself.
  await markAvailable()
  await expect(page.getByRole('region', { name: 'Your score' })).toBeVisible({ timeout: 150_000 })
  const graded = await withPrisma((prisma) =>
    prisma.processingJob.findFirstOrThrow({
      where: { jobType: 'grade_exam', targetKey: `grade:${submissionId}` },
      select: { status: true },
    })
  )
  expect(graded.status).toBe('completed')
})

test('mock exam: a failed exam goes back to the form with every choice kept', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await page.goto(`${course}/exams/new`)
  await page.getByRole('radio', { name: '10', exact: true }).click()
  await page.getByRole('radio', { name: '30 min' }).click()

  // The job fails (a passing outage that used its retries).
  await page.route('**/api/jobs/*', async (route) => {
    const id = route.request().url().split('/').pop()
    await route.fulfill({
      json: { id, jobType: 'generate_exam', status: 'failed', errorCode: 'LLM_UNAVAILABLE', retryable: true, progressPercent: 100 },
    })
  })
  await page.getByRole('button', { name: 'Create exam' }).click()

  const failure = page.getByRole('alert').filter({ hasText: "Your exam couldn't be written" })
  await expect(failure).toBeVisible({ timeout: 30_000 })
  await expect(failure).toContainText('The AI is busy right now. Try again in a few minutes.')
  // No promise that it is still coming, and nothing chosen is lost.
  await expect(page.getByText('Writing your exam')).toBeHidden()
  await expect(page.getByText(/This takes about a minute or two/)).toBeHidden()
  await expect(page.getByRole('radio', { name: '10', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: '30 min' })).toBeChecked()

  // Try again works once the AI is back.
  await page.unroute('**/api/jobs/*')
  await failure.getByRole('button', { name: 'Try again' }).click()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })
})
