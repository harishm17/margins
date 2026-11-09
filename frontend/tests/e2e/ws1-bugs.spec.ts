import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { signIn } from './helpers/auth'
import { addContent, addFileRow, createCourse, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { DEMO_EMAIL, FIXTURE_PDF, demoIds } from './helpers/seed-demo'
import { recallWorld } from './helpers/v31-recall'
import { streamedPartsArrived } from './helpers/settle'
import { chooseConfidence } from './helpers/confidence'

// UX review fixes, workstream 1: bugs that lose work or break a flow (items 1, 2, 5, 6, 7 and 14 of the review).
test.use({ timezoneId: ZONE })

const demo = demoIds()
const PHONE = { width: 390, height: 844 }

// ---------------------------------------------------------------------------------------------------------- 1. unsent text

test.describe('unsent text survives a reload', () => {
  test('ask: the question is kept until the server has it', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    const ask = `/courses/${demo.course}/ask`
    await page.goto(ask, { waitUntil: 'networkidle' })
    const box = page.getByLabel('Ask about your materials')

    // A send that never reaches the server loses nothing.
    await page.route('**/api/projects/*/chat', (route) => route.abort())
    await box.fill('Why does a hash table resize?')
    await expect(page.getByTestId('ask-draft-status')).toHaveText('Saved', { timeout: 15_000 })
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: /Try again|Retry/ }).first()).toBeVisible({ timeout: 15_000 })
    await page.unroute('**/api/projects/*/chat')
    await page.goto(ask, { waitUntil: 'networkidle' })
    await expect(page.getByLabel('Ask about your materials')).toHaveValue('Why does a hash table resize?')

    // Sent for real: the box empties, and the draft is gone for good.
    await page.getByLabel('Ask about your materials').fill(`What is hashing? ${Date.now()}`)
    await expect(page.getByTestId('ask-draft-status')).toHaveText('Saved', { timeout: 15_000 })
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[?&]thread=/, { timeout: 30_000 })
    await expect(page.locator('article', { hasText: 'Sources' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('article[aria-busy]')).toHaveCount(0)
    await page.goto(ask, { waitUntil: 'networkidle' })
    await expect(page.getByLabel('Ask about your materials')).toHaveValue('')
    const drafts = await withPrisma((prisma) => prisma.studyDraft.count({ where: { surface: 'ask', projectId: demo.course } }))
    expect(drafts).toBe(0)
  })

  test('warm-up: the answer and the confidence come back', async ({ page }) => {
    await page.setViewportSize(PHONE)
    const { topicUrl } = await recallWorld(page, 'ws1-warmup', { warmup: true, readAt: false })
    await page.goto(`${topicUrl}?view=warmup`)
    await page.getByRole('button', { name: 'Start warm-up' }).click()
    await expect(page.getByRole('heading', { name: /Warm-up question 1 of/ })).toBeVisible()
    await page.getByRole('radio', { name: /Option B for question/ }).click()
    await chooseConfidence(page, 'Fairly sure')
    await expect(page.getByTestId('warmup-draft-status')).toHaveText('Saved', { timeout: 15_000 })
    await page.reload()
    await expect(page.getByRole('heading', { name: /Warm-up question 1 of/ })).toBeVisible()
    await expect(page.getByRole('radio', { name: /Option B for question/, checked: true })).toBeVisible({ timeout: 15_000 })
    // The row is folded on a phone: the line says the level that came back.
    await expect(page.getByRole('button', { name: 'Confidence: Fairly sure' })).toBeVisible()
  })

  test('worked examples: the prediction, the reveal and the grade come back', async ({ page }) => {
    // This is about the guess boxes of an example on screen together: the "See the steps" view (the default is "Try each step").
    await page.addInitScript(() => localStorage.setItem('margins.examplesStepMode', 'all'))
    await page.setViewportSize({ width: 1280, height: 900 })
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, 'ws1-examples', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Examples ${Date.now()}`, [{ name: 'Novice topic' }])
    const topicId = course.topics['Novice topic']
    const example = (title: string) => ({
      title,
      difficulty: 'medium',
      problem_statement: `Insert keys for ${title}.`,
      solution_steps: [1, 2, 3].map((n) => ({ step_number: n, description: `${title} step ${n}`, work: `Work ${title} ${n}.`, explanation: `Reason ${title} ${n}.` })),
      final_answer: `Answer ${title}.`,
      key_concepts: ['Chaining'],
    })
    await addContent(topicId, { solved_examples: [example('Alpha'), example('Beta')] })
    const url = `/courses/${course.courseId}/topics/${topicId}?view=examples`
    await page.goto(url)
    await streamedPartsArrived(page)

    const whys = page.getByRole('group', { name: 'Why this step? Write your guess' })
    await whys.nth(0).getByLabel('Your guess').fill('Because the bucket was taken.')
    await whys.nth(0).getByRole('button', { name: 'Show why' }).click()
    await page.getByRole('button', { name: 'Got it' }).click()
    await expect(page.getByRole('status').filter({ hasText: /(Saved|Noted, not counted): Got it/ })).toBeVisible()
    // A guess that was written and not yet revealed.
    await whys.first().getByLabel('Your guess').fill('Because of the load factor.')
    await expect(page.getByTestId('examples-draft-status')).toHaveText('Saved', { timeout: 15_000 })

    await page.reload()
    await streamedPartsArrived(page)
    await expect(page.getByText('Reason Alpha 1.')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('status').filter({ hasText: /(Saved|Noted, not counted): Got it/ })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Why this step? Write your guess' }).first().getByLabel('Your guess')).toHaveValue('Because of the load factor.')
  })
})

// ---------------------------------------------------------------------------------------------------------- 5 and 6. uploads

test.describe('materials', () => {
  async function courseWithFile(page: Page, label: string) {
    const { email } = await signUpAndIn(page, label, { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const created = await page.request.post('/api/projects', { data: { name: `Materials ${Date.now()}` } })
    const courseId = (await created.json()).project.id as string
    await addFileRow(courseId, 'other.pdf')
    return courseId
  }
  const rows = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name.replace('.', '\\.')) })

  test('a file deleted right after it was uploaded stays deleted', async ({ page }) => {
    const courseId = await courseWithFile(page, 'ws1-delete')
    await page.goto(`/courses/${courseId}/materials`)
    await page.getByLabel('Choose files to upload').setInputFiles(FIXTURE_PDF)
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(1)
    await page.getByRole('button', { name: 'Actions for algorithms.pdf' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete file' }).click()
    await expect(page.getByText('File deleted')).toBeVisible()
    // Not back as a file still being checked, now or after the page refreshes itself.
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(0)
    await page.waitForTimeout(3000)
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(0)
    await expect(page.getByText('Checking the file')).toHaveCount(0)
  })

  test('a repeated file asks first: cancel, keep both, or replace', async ({ page }) => {
    const courseId = await courseWithFile(page, 'ws1-duplicate')
    await page.goto(`/courses/${courseId}/materials`)
    const input = page.getByLabel('Choose files to upload')
    await input.setInputFiles(FIXTURE_PDF)
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(1)
    await expect(rows(page, 'algorithms.pdf').getByText('Ready')).toBeVisible({ timeout: 90_000 })

    // Cancel: nothing is uploaded.
    await input.setInputFiles(FIXTURE_PDF)
    const dialog = page.getByRole('dialog', { name: 'This file is already here' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('duplicate-files')).toContainText('algorithms.pdf')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await page.waitForTimeout(1000)
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(1)

    // Keep both: a second row.
    await input.setInputFiles(FIXTURE_PDF)
    await page.getByRole('dialog', { name: 'This file is already here' }).getByRole('button', { name: 'Keep both' }).click()
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(2, { timeout: 30_000 })

    // Replace: the new copy goes in and the earlier ones come out.
    await input.setInputFiles(FIXTURE_PDF)
    await page.getByRole('dialog', { name: 'This file is already here' }).getByRole('button', { name: 'Replace' }).click()
    await expect.poll(async () => rows(page, 'algorithms.pdf').count(), { timeout: 60_000 }).toBe(1)
    // A different file is never held up.
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

})

// ---------------------------------------------------------------------------------------------------------- 7. exam save status on a phone

test('the timed exam shows Saving, Saved and a failure with Retry on a phone', async ({ page }) => {
  await page.setViewportSize(PHONE)
  const { email } = await signUpAndIn(page, 'ws1-exam-save', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Exam save ${Date.now()}`, [{ name: 'Hash tables' }])
  const examId = await withPrisma(async (prisma) => {
    const exam = await prisma.sampleExam.create({
      data: {
        projectId: course.courseId,
        name: 'Save status exam',
        questions: [1, 2, 3].map((n) => ({ question_type: 'true_false', question_text: `Statement ${n} is true.`, correct_answer: true, points: 1 })),
        durationMinutes: 30,
        difficultyLevel: 'medium',
        topicsCovered: ['Hash tables'],
      },
    })
    return exam.id
  })
  expect((await page.request.post(`/api/exams/${examId}/attempt`)).ok()).toBeTruthy()
  await page.goto(`/courses/${course.courseId}/exams/${examId}/take`)
  const status = page.getByTestId('exam-save-status')

  await page.getByRole('radio').first().click()
  await expect(status).toHaveText('Saved', { timeout: 20_000 })
  const box = await status.boundingBox()
  expect(box, 'the status is on screen').not.toBeNull()
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width)

  // A save that fails says so, with a way to try again.
  await page.route(`**/api/exams/${examId}/attempt`, (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()))
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('radio').first().click()
  await expect(status).toContainText('Not saved', { timeout: 20_000 })
  // First "Not saved yet" while the change waits its turn, then "Not saved" with Retry once the save has failed.
  await expect(status.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 20_000 })
  await page.unroute(`**/api/exams/${examId}/attempt`)
  await status.getByRole('button', { name: 'Retry' }).click()
  await expect(status).toHaveText('Saved', { timeout: 20_000 })
})

// ---------------------------------------------------------------------------------------------------------- 3. voice: Quiz me says before Start

test.describe('voice lobby: Quiz me', () => {
  const lobby = (page: Page) => page.getByTestId('voice-lobby')

  test('a topic with no quiz says so before Start, disables Quiz me, and offers the quiz', async ({ page }) => {
    const { email } = await signUpAndIn(page, 'ws1-voice-none', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Voice none ${Date.now()}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=voice`)
    await expect(lobby(page)).toBeVisible({ timeout: 30_000 })
    const alert = page.getByTestId('voice-quiz-missing')
    await expect(alert).toContainText('Quiz me needs a quiz first')
    await expect(alert).toContainText("This topic doesn't have a quiz yet")
    await expect(alert.getByRole('link', { name: 'Write the quiz' })).toHaveAttribute('href', `/courses/${course.courseId}/topics/${topicId}?view=quiz`)
    await expect(page.getByRole('button', { name: 'Start voice practice' })).toBeDisabled()
  })

  test('a quiz whose questions mention numbers is not treated as empty, and Quiz me can start', async ({ page }) => {
    const { email } = await signUpAndIn(page, 'ws1-voice-ready', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Voice ready ${Date.now()}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    // The wording a real quiz has: a digit in a step, a big-O in the key, and words that merely contain "sum" or "solve".
    await addContent(topicId, {
      topic_quiz: [
        { question_type: 'true_false', question_text: 'A hash lookup is O(1) on average.', correct_answer: true, explanation: 'Averaged over 100 keys.', points: 1, difficulty: 'medium' },
        { question_type: 'true_false', question_text: 'We assume the hash spreads keys evenly, and resolve collisions by chaining.', correct_answer: true, points: 1, difficulty: 'medium' },
      ],
    })
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=voice`)
    await expect(lobby(page)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('voice-quiz-missing')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start voice practice' })).toBeEnabled({ timeout: 15_000 })
    // The server agrees: a session starts with both questions.
    const started = await page.request.post('/api/voice/session', {
      data: { projectId: course.courseId, topicId, mode: 'topic_drill', style: 'oral_quiz', language: 'en' },
    })
    expect(started.ok()).toBeTruthy()
    expect((await started.json()).questionCount).toBe(2)
  })
})

