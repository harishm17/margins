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
