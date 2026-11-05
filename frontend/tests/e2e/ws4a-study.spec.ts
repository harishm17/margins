import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { addContent, addQuizSet, createCourse, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { withPrisma } from './helpers/db'
import { FIXTURE_PDF } from './helpers/seed-demo'
import { signIn } from './helpers/auth'

// Study surfaces, design and flow (UX review WS4a): the first entry of a topic and its preparation, the one question navigator
// of the quiz and the mock exam, the phone targets of the topic's controls and the topic editor, and the course setup links.
// Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const path = (page: Page) => page.getByRole('navigation', { name: 'Topic path' })

test.describe('the first entry of a topic', () => {
  test('is a preparation screen, never the reader, then the warm-up; reading stays one tap away', async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize(DESKTOP)
    const email = `ws4a-entry-${Date.now()}@example.com`
    await signIn(page, email)
    const project = await page.request.post('/api/projects', { data: { name: `Entry ${Date.now()}` } })
    const courseId = (await project.json()).project.id as string
    const upload = await page.request.post(`/api/projects/${courseId}/materials?category=lecture_notes&filename=algorithms.pdf`, {
      data: readFileSync(FIXTURE_PDF),
      headers: { 'content-type': 'application/pdf' },
    })
    expect(upload.ok()).toBeTruthy()
    await expect
      .poll(async () => ((await (await page.request.get(`/api/projects/${courseId}/materials`)).json()).materials as { validationStatus: string }[]).map((item) => item.validationStatus).join(), { timeout: 120_000 })
      .toBe('valid')
    // Topic finding starts by itself and would undo the confirmation below if it were still running.
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${courseId}/topics`)).json()).topics.length, { timeout: 120_000 }).toBeGreaterThan(0)
    const topic = await page.request.post(`/api/projects/${courseId}/topics`, { data: { name: 'Graph traversal', description: 'Breadth-first and depth-first search.' } })
    expect(topic.ok()).toBeTruthy()
    const topicId = (await topic.json()).topic.id as string
    await page.request.post(`/api/projects/${courseId}/topics/confirm`)
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const base = `/courses/${courseId}/topics/${topicId}`

    // Preparation is held (the stack's E2E_HOLD_DIR hook), so the screen can be looked at while the warm-up is being written.
    const holdDir = join(process.env.E2E_RUN_DIR || join(process.cwd(), '..', '.e2e'), 'hold')
    const gate = join(holdDir, 'generate_content.hold')
    await mkdir(holdDir, { recursive: true })
    await writeFile(gate, '')
    try {
      await page.goto(base)
      await expect(page).toHaveURL(/\?view=read&entry=1$/)
      await expect(page.getByRole('heading', { name: 'Writing your warm-up questions, about a minute' })).toBeVisible()
      // The reader is not shown, and the path keeps its five steps: Warm-up and Recall say they are being prepared, none is tagged Next.
      await expect(page.locator('[data-passage]')).toHaveCount(0)
      for (const label of ['Warm-up', 'Read', 'Recall', 'Practice', 'Quiz']) await expect(path(page).getByRole('link', { name: new RegExp(label) })).toBeVisible()
      await expect(path(page).getByRole('link', { name: /Warm-up/ }).getByRole('img', { name: 'Being prepared' })).toBeVisible()
      await expect(path(page).getByRole('link', { name: /Recall/ }).getByRole('img', { name: 'Being prepared' })).toBeVisible()
      await expect(path(page).getByText('(next up)')).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Next on this topic' })).toHaveCount(0)
      await screenshotIfAsked(page, 'ws4a-entry-preparing-1440x900')
      await expectNoAxeViolations(page, 'topic entry, preparing, 1440')

      await page.setViewportSize(PHONE)
      await screenshotIfAsked(page, 'ws4a-entry-preparing-390x844')
      const reading = page.getByRole('link', { name: 'Start reading instead' })
      expect((await reading.boundingBox())!.height, 'Start reading instead is a 44px target on a phone').toBeGreaterThanOrEqual(44)
      // On a phone the panel is the page: the path of five steps gives way to the small bar (the topic, Exit), which is a 44px target.
      await expect(path(page)).toBeHidden()
      await expect(page.getByTestId('attempt-bar').getByRole('link', { name: 'Exit' })).toBeVisible()
      expect((await page.getByTestId('attempt-bar').getByRole('link', { name: 'Exit' }).boundingBox())!.height, 'Exit is a 44px target on a phone').toBeGreaterThanOrEqual(44)
      await page.setViewportSize(DESKTOP)
      await expect(path(page)).toBeVisible()

      // Reading is a choice, not a fallback: it leaves the preparation screen at once (this topic has no pages of its own to read yet,
      // so the Read step shows its notes being written).
      await reading.click()
      await expect(page).toHaveURL(/\?view=read$/)
      await expect(page.getByRole('heading', { name: 'Writing your warm-up questions, about a minute' })).toHaveCount(0)
      await page.goto(base)
      await expect(page).toHaveURL(/\?view=read&entry=1$/)
    } finally {
      await rm(gate, { force: true })
    }
    // Let go of what is held: the screen opens the warm-up by itself once it is written, once.
    for (const file of readdirSync(holdDir)) if (file.endsWith('.request.json')) await writeFile(join(holdDir, file.replace('.request.json', '.release')), '')
    await expect(page).toHaveURL(/\?view=warmup$/, { timeout: 150_000 })
    await expect(page.getByRole('button', { name: 'Start warm-up' })).toBeVisible()
    await expect(path(page).getByRole('img', { name: 'Being prepared' })).toHaveCount(0)
  })
})

test.describe('the question navigator', () => {
  test('is one component for the quiz: 44px on a phone, a check on answered, an outline on the current, and a sheet of all of them', async ({ page }) => {
    test.setTimeout(120_000)
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, 'ws4a-nav', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Navigator ${Date.now()}`, [{ name: 'Hashing' }])
    const topicId = course.topics.Hashing
    await addContent(topicId, { section_notes: '# Notes\n\nSome notes.' })
    await addQuizSet(topicId, quizQuestions(10))
    await page.setViewportSize(PHONE)
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=quiz`)
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await expect(page.getByRole('heading', { name: 'Question 1 of 10' })).toBeVisible()
    await page.getByRole('radio').first().click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    // One navigator on a phone: the Questions button and its sheet. The row of numbers is for wide screens, where it is the only one.
    await expect(page.getByRole('navigation', { name: 'Questions' })).toBeHidden()
    await page.setViewportSize(DESKTOP)
    const nav = page.getByRole('navigation', { name: 'Questions' })
    const one = nav.getByRole('button', { name: /^Question 1,/ })
    const two = nav.getByRole('button', { name: /^Question 2,/ })
    await expect(one).toHaveAccessibleName('Question 1, answered')
    await page.setViewportSize(PHONE)
    // Answered carries a check, not only a fill; the current one an accent outline of 2px, not a faint ring.
    await page.setViewportSize(DESKTOP)
    await expect(one.locator('svg')).toHaveCount(1)
    await expect(two).toHaveAttribute('aria-current', 'step')
    expect(await two.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('2px')
    expect(await one.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px')
    await page.setViewportSize(PHONE)

    // The sheet lists every number without swiping, as 44px targets.
    await page.getByRole('button', { name: 'Questions', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Questions' })
    expect((await sheet.getByRole('button', { name: /^Question 1,/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect((await sheet.getByRole('button', { name: /^Question 1,/ }).boundingBox())!.width).toBeGreaterThanOrEqual(44)
    await expect(sheet.getByRole('button', { name: /^Question 10,/ })).toBeVisible()
    expect((await sheet.getByRole('button', { name: /^Question 10,/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await screenshotIfAsked(page, 'ws4a-quiz-navigator-sheet-390x844')
    await sheet.getByRole('button', { name: /^Question 10,/ }).click()
    await expect(page.getByRole('heading', { name: 'Question 10 of 10' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await screenshotIfAsked(page, 'ws4a-quiz-navigator-390x844')
    await expectNoAxeViolations(page, 'quiz navigator, 390')
  })
})

test.describe('phone targets in the study surfaces', () => {
  test('the topic editor and the setup links are 44px on a phone', async ({ page }) => {
    test.setTimeout(120_000)
    await setZoneCookie(page.context())
    await signUpAndIn(page, 'ws4a-targets', { own: true })
    const course = await createCourse(page, `Targets ${Date.now()}`, [{ name: 'Hashing' }, { name: 'Sorting' }])
    await withPrisma((prisma) => prisma.topic.updateMany({ where: { projectId: course.courseId }, data: { description: 'A long description of what this topic covers, which should wrap onto more than one line on a narrow screen instead of being cut off.' } }))
    await page.setViewportSize(PHONE)
    await page.goto(`/courses/${course.courseId}/topics?edit=1`)
    // A phone has no drag handle: the row menu's Move up and Move down are the way to reorder.
    await expect(page.getByRole('button', { name: 'Actions for Hashing' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reorder Hashing/ })).toBeHidden()
    const rename = page.getByRole('button', { name: 'Rename Hashing' })
    expect((await rename.boundingBox())!.height, 'rename').toBeGreaterThanOrEqual(44)
    // The description wraps, so the student can read what they are confirming (on a phone it is behind Show details).
    await page.getByRole('button', { name: 'Show details of Hashing' }).click()
    const description = page.getByText('A long description of what this topic covers').first()
    expect((await description.boundingBox())!.height, 'description is more than one line').toBeGreaterThan(30)
    // Saving and cancelling are buttons, not only Enter and Escape.
    await rename.click()
    await page.getByRole('textbox', { name: 'Topic name' }).fill('Hashing and tables')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Rename Hashing and tables' })).toBeVisible()
    await page.getByRole('button', { name: 'Rename Hashing and tables' }).click()
    await page.getByRole('textbox', { name: 'Topic name' }).fill('Not kept')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Rename Hashing and tables' })).toBeVisible()
    await screenshotIfAsked(page, 'ws4a-topic-editor-390x844')
    await expectNoAxeViolations(page, 'topic editor, 390')
  })
})
