import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'

// Runs against the demo course (seeded by global-setup.ts) on a stack with the mock AI service.
const course = `/courses/${demoIds().course}`

test('ask: an answer streams in with citations, then the conversation can be deleted', async ({ page }) => {
  await signIn(page, DEMO_EMAIL)
  await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { level: 2, name: 'Ask your materials' })).toBeVisible()

  const question = `What is hashing? ${Date.now()}`
  await page.getByLabel('Ask about your materials').fill(question)
  await page.keyboard.press('Enter')

  const answer = page.locator('article', { hasText: 'Sources' })
  await expect(answer).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/[?&]thread=/)

  // The live answer is replaced by the stored one when it finishes; hover after that.
  await expect(page.locator('article[aria-busy]')).toHaveCount(0)
  // A citation pill opens a hover card with the quote and a way to read it (open the page for a
  // PDF, an excerpt dialog for other files).
  await answer.getByRole('button', { name: /^Source 1/ }).first().hover()
  const card = page.locator('blockquote').first()
  await expect(card).toBeVisible()
  await expect(page.getByRole('button', { name: /^(View excerpt)$/ }).or(page.getByRole('link', { name: 'Open page' })).first()).toBeVisible()

  // The conversation is in the list; delete it.
  const row = page.getByRole('link', { name: question.slice(0, 20) }).first()
  await expect(row).toBeVisible()
  await page.getByRole('button', { name: /^Options for What is hashing/ }).first().click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete conversation' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Ask your materials' })).toBeVisible()
})

test('ask: Stop aborts a slow answer', async ({ page }) => {
  await signIn(page, DEMO_EMAIL)
  // Hold the answer back so there is something to stop.
  await page.route('**/api/projects/*/chat', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await route.abort()
  })
  await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })
  await page.getByLabel('Ask about your materials').fill('Explain sorting.')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Searching your materials...')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Searching your materials...')).toBeHidden()
})

test('mock exam: create, take, submit and read the results', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, DEMO_EMAIL)
  await page.goto(`${course}/exams/new`)
  await page.getByRole('radio', { name: '10', exact: true }).click()
  await page.getByRole('radio', { name: '30 min' }).click()
  await page.getByRole('button', { name: 'Create exam' }).click()
  await expect(page.getByText('Writing your exam')).toBeVisible()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })
  await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible()

  await page.getByRole('button', { name: /^(Start exam|Resume)/ }).click()
  await expect(page).toHaveURL(/\/take$/)
  await expect(page.getByRole('timer')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Question 1 of/ })).toBeVisible()

  // Answer the first question, flag the second, and the navigator shows both.
  const choice = page.getByRole('radio').first()
  if (await choice.isVisible()) await choice.click()
  else await page.getByLabel('Your answer').fill('1')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: /Question 2 of/ })).toBeVisible()
  await page.getByRole('button', { name: 'Flag', exact: true }).click()
  await expect(page.getByText(/1 answered, 1 flagged/)).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 15_000 })

  // Exit asks first.
  await page.getByRole('link', { name: 'Exit' }).click()
  await expect(page.getByRole('dialog', { name: 'Leave the exam?' })).toBeVisible()
  await page.getByRole('button', { name: 'Stay' }).click()

  // Submitting with blanks asks for confirmation.
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Submit your exam?' })).toContainText('unanswered')
  await page.getByRole('dialog').getByRole('button', { name: 'Submit exam' }).click()
  await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}$/, { timeout: 30_000 })

  // Grading, then the score and the review.
  await expect(page.getByText('of ').first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('heading', { name: 'Where to focus' })).toBeVisible({ timeout: 120_000 })
  await page.getByRole('radio', { name: /^Missed/ }).click()
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
})
