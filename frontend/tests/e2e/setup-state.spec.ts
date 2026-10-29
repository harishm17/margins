import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { createEmptyCourse, setZoneCookie, signIn, ZONE } from './helpers/loop'

// Course setup has one state on every screen (lib/course-setup.ts). Topic finding fails, the student
// adds topics by hand, and nothing counts as set up until they press Confirm: then the overview ticks
// step 2, Home moves on and the Plan shows.

test.use({ timezoneId: ZONE })
test.setTimeout(180_000)

/** A course with one readable file whose topic finding failed for good (no model call needed). */
async function courseWithFailedDiscovery(page: Page, email: string): Promise<string> {
  const courseId = await createEmptyCourse(page, 'Probability by hand')
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    await prisma.material.create({
      data: {
        projectId: courseId,
        category: 'lecture_notes',
        filename: 'probability.pdf',
        gcsPath: `e2e/${courseId}/probability.pdf`,
        sizeBytes: BigInt(1024),
        validationStatus: 'valid',
      },
    })
    await prisma.processingJob.create({
      data: {
        userId: user.id,
        projectId: courseId,
        jobType: 'extract_topics',
        status: 'failed',
        stage: 'extracting',
        errorCode: 'TOPIC_EXTRACTION_FAILED',
        errorMessage: 'No topics extracted',
        retryable: false,
        attemptCount: 3,
        completedAt: new Date(),
      },
    })
  })
  return courseId
}

async function ownAccount(page: Page): Promise<{ email: string; password: string }> {
  const user = { email: `setup-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`, password: 'setup-state-password' }
  const signup = await page.request.post('/api/auth/signup', { data: { ...user, name: 'Setup Tester' } })
  expect(signup.status()).toBe(201)
  await signIn(page, user.email, user.password)
  return user
}

const upNext = (page: Page) => page.getByRole('region', { name: /Up next/ })

test('failed topic finding, topics added by hand, then Confirm finishes setup everywhere', async ({ page, context }) => {
  await setZoneCookie(context)
  // An account of its own: Home's "Up next" follows the account's most recent course, and the shared
  // spec account (helpers/loop.ts) has other courses with study activity.
  const user = await ownAccount(page)
  const courseId = await courseWithFailedDiscovery(page, user.email)
  const base = `/courses/${courseId}`

  // Overview: step 2 shows the failure as an alert, and a way to write the list by hand.
  await page.goto(base)
  const step2 = page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 2, name: 'Check the topics' }) })
  await expect(step2.getByRole('alert')).toContainText("We couldn't find topics")
  await expect(page.getByText(/We found/)).toHaveCount(0)
  await page.goto('/home')
  await expect(upNext(page)).toContainText('Add topics')

  // The Topics page goes to the editor while the list is not confirmed.
  await page.goto(`${base}/topics`)
  await expect(page).toHaveURL(new RegExp(`${base}/topics\\?edit=1$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Check the topics' })).toBeVisible()

  // Enter twice in a row: the field keeps focus and the second topic is not lost to a refresh.
  const add = page.getByLabel('Add a topic').locator('visible=true')
  await add.click()
  await page.keyboard.type('Bayes rule')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Conditional probability')
  await page.keyboard.press('Enter')
  const rows = page.getByRole('list', { name: /^Topics$/ }).getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Rename Bayes rule' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rename Conditional probability' })).toBeVisible()
  await expect(add).toBeFocused()
  await expect(add).toHaveValue('')

  // Still the first-run editor after the refreshes: Confirm, not Done, and the failure stays in view.
  await expect(page).toHaveURL(/\?edit=1$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Check the topics' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm topics' })).toBeEnabled()
  await expect(page.getByRole('link', { name: 'Done' })).toHaveCount(0)
  await expect(page.getByRole('alert').filter({ hasText: "We couldn't find topics" })).toBeVisible()
  await page.reload()
  await expect(rows).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Confirm topics' })).toBeVisible()

  // Every screen agrees the list is not confirmed yet.
  await page.goto(base)
  await expect(step2.getByText('You added 2 topics.')).toBeVisible()
  await expect(step2.getByRole('link', { name: 'Confirm topics' })).toBeVisible()
  await expect(page.getByText('Topics need review').first()).toBeAttached()
  await page.goto('/home')
  await expect(upNext(page)).toContainText('Confirm topics')
  await page.goto(`${base}/plan`)
  await expect(page.getByRole('heading', { level: 2, name: 'Your plan starts with your topics' })).toBeVisible()

  // Confirm: back on the overview, step 2 is ticked and step 3 is next.
  await page.getByRole('link', { name: 'Confirm topics' }).click()
  await expect(page).toHaveURL(new RegExp(`${base}/topics\\?edit=1$`))
  await page.getByRole('button', { name: 'Confirm topics' }).click()
  await expect(page).toHaveURL(new RegExp(`${base}$`))
  await expect(page.getByText('Done: step 2')).toBeAttached()
  await expect(page.getByText('2 topics confirmed.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Start studying' })).toBeVisible()
  await expect(page.getByText('Topics need review')).toHaveCount(0)

  // Home moves on to the first topic, the Plan shows, and Topics is the list.
  await page.goto('/home')
  await expect(upNext(page)).not.toContainText('Confirm topics')
  await expect(upNext(page)).toContainText('Bayes rule')
  await page.goto(`${base}/plan`)
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
  await expect(page.getByText('Your plan starts with your topics')).toHaveCount(0)
  await expect(page.getByText('Bayes rule').first()).toBeVisible()
  await page.goto(`${base}/topics`)
  await expect(page).toHaveURL(new RegExp(`${base}/topics$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Topics' })).toBeVisible()

  // The only file is deleted before anything was written: every screen asks for files again. The
  // confirmed list stays a list (no second Confirm), but there is no plan to follow without files.
  const materialId = await withPrisma(async (prisma) =>
    (await prisma.material.findFirstOrThrow({ where: { projectId: courseId }, select: { id: true } })).id
  )
  expect((await page.request.delete(`/api/materials/${materialId}`)).ok()).toBeTruthy()
  await page.goto('/home')
  await expect(upNext(page)).toContainText('Upload materials')
  await page.goto(`${base}/plan`)
  await expect(page.getByRole('heading', { level: 2, name: 'Your plan starts with your topics' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Add materials' })).toBeVisible()
  await page.goto(`${base}/topics`)
  await expect(page).toHaveURL(new RegExp(`${base}/topics$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Topics' })).toBeVisible()
  await page.goto(base)
  await expect(page.getByRole('heading', { level: 2, name: 'Add your materials' })).toBeVisible()
  // Step 1 itself (the heading shows at every step): it is the current step and not ticked.
  const step1 = page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 2, name: 'Add your materials' }) })
  await expect(step1).toHaveAttribute('aria-current', 'step')
  await expect(page.getByText('Done: step 1')).toHaveCount(0)
})

test('adds that fail while queued are kept, in order, until retried or removed', async ({ page, context }) => {
  await setZoneCookie(context)
  const user = await ownAccount(page)
  const courseId = await courseWithFailedDiscovery(page, user.email)

  // Every add is slow and then fails, so both are queued before the first answer comes back.
  let fail = true
  await page.route(`**/api/projects/${courseId}/topics`, async (route) => {
    if (route.request().method() !== 'POST' || !fail) return route.fallback()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Failed to create topic' }) })
  })

  await page.goto(`/courses/${courseId}/topics?edit=1`)
  const add = page.getByLabel('Add a topic').locator('visible=true')
  await add.click()
  await page.keyboard.type('Bayes rule')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Conditional probability')
  await page.keyboard.press('Enter')

  // Neither name is lost: both stay on screen as topics that were not added, first one first.
  const notAdded = page.getByRole('list', { name: 'Topics not added' }).getByRole('listitem')
  await expect(notAdded).toHaveCount(2, { timeout: 10_000 })
  await expect(notAdded.nth(0)).toContainText('Bayes rule')
  await expect(notAdded.nth(1)).toContainText('Conditional probability')
  // The server's reason is kept on the row (the generic text is only for errors with no message).
  await expect(notAdded.nth(0)).toContainText('Failed to create topic')
  // Confirm waits until they are dealt with.
  await expect(page.getByRole('button', { name: 'Confirm topics' })).toBeDisabled()

  // Retry one (now the server takes it), remove the other.
  fail = false
  await notAdded.nth(0).getByRole('button', { name: 'Retry Bayes rule' }).click()
  await expect(page.getByRole('button', { name: 'Rename Bayes rule' })).toBeVisible()
  await notAdded.getByRole('button', { name: 'Remove Conditional probability' }).click()
  await expect(notAdded).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Confirm topics' })).toBeEnabled()
  await expect(page.getByRole('list', { name: /^Topics$/ }).getByRole('listitem')).toHaveCount(1)
})
