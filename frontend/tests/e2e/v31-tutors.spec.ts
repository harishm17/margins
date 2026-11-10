import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { createCourse, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { streamedPartsArrived } from './helpers/settle'
import { seedTutorReading } from './helpers/v31-tutors'

// Workstream T (spec 18.6): Ask's turn counter, the reader tutor's second turn and the voice moves, on the mock AI service.

// ---------------------------------------------------------------------------------------------------------
// The reader tutor's second turn and the restatement (spec §18.6). The mock tutor reads the answer's words
// against the passage: none in common is Not yet, one is Partly, two or more is Right.

test.describe('the reader tutor', () => {
  test.use({ timezoneId: ZONE })

  async function readerWorld(page: Page, label: string) {
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, label, { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Reader ${Date.now()}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    const seeded = await seedTutorReading(topicId)
    return { email, topicId, topicUrl: `/courses/${course.courseId}/topics/${topicId}`, ...seeded }
  }

  async function openReader(page: Page, url: string) {
    await page.goto(url)
    await streamedPartsArrived(page)
    await expect(page.locator('[data-passage]').first()).toBeVisible()
    const passages = await page.locator('[data-passage]').count()
    await expect(page.locator('[data-passage] .md')).toHaveCount(passages)
  }

  test('reader check question has an answer box and a reply', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const { email, topicUrl } = await readerWorld(page, 'v31-reader-check')
    await openReader(page, `${topicUrl}?view=read`)
    const passage = page.locator('[data-passage]').nth(2)
    await passage.getByRole('button', { name: /Explain this passage: passage 3/ }).click()
    await passage.getByRole('textbox').fill('It says the table keeps a list in each bucket for keys that collide.')
    await passage.getByRole('button', { name: 'Ask the tutor' }).click()
    await expect(passage.locator('[data-note="question"]')).toContainText('Check yourself')

    // The check question has an answer box and an "I don't know".
    const form = passage.getByRole('form', { name: /Answer the check question on passage 3/ })
    await expect(form).toBeVisible()
    const send = form.getByRole('button', { name: 'Check my answer' })
    await expect(send).toBeDisabled()
    await expect(form.getByRole('button', { name: "I don't know" })).toBeEnabled()
    await screenshotIfAsked(page, 'v31-reader-answer-box-1440x900')
    await expectNoAxeViolations(page, 'reader: the check question with its answer box')

    // A wrong answer: Not yet, and one more question in the same thread, with a new answer box.
    await form.getByLabel('Your answer').fill('Photosynthesis turns light into sugar.')
    await send.click()
    const answer = passage.locator('[data-note="answer"]').first()
    await expect(answer).toContainText('Your answer')
    await expect(answer.locator('[data-verdict="not_yet"]')).toHaveText("Tutor's verdict: Not yet")
    await expect(answer).toContainText('Check yourself')
    await expect(answer).toBeFocused()
    await expect(passage.getByRole('form', { name: /Answer the check question/ })).toHaveCount(1)
    await expectNoAxeViolations(page, 'reader: a verdict with a follow-up question')

    // "I don't know" on the follow-up is the same turn: Not yet again.
    await passage.getByRole('button', { name: "I don't know" }).click()
    await expect(passage.locator('[data-note="answer"]')).toHaveCount(2)
    await expect(passage.locator('[data-note="answer"]').nth(1)).toContainText("I don't know")
    await expect(passage.locator('[data-note="answer"]').nth(1).locator('[data-verdict="not_yet"]')).toHaveText("Tutor's verdict: Not yet")

    // A right answer ends the thread: the verdict, and no more answer box.
    await passage.getByLabel('Your answer').fill('Chaining keeps every colliding entry in a list that hangs off the bucket.')
    await passage.getByRole('button', { name: 'Check my answer' }).click()
    await expect(passage.locator('[data-note="answer"]')).toHaveCount(3)
    await expect(passage.locator('[data-note="answer"]').nth(2).locator('[data-verdict="right"]')).toHaveText("Tutor's verdict: Right")
    await expect(passage.getByRole('form', { name: /Answer the check question/ })).toHaveCount(0)
    await screenshotIfAsked(page, 'v31-reader-verdict-1440x900')

    // The thread is still there after a reload, with its verdicts.
    await page.reload()
    await streamedPartsArrived(page)
    await expect(page.locator('[data-passage]').nth(2).locator('[data-note="answer"]')).toHaveCount(3)
    await expect(page.locator('[data-passage]').nth(2).locator('[data-note="answer"]').nth(2).locator('[data-verdict="right"]')).toHaveText("Tutor's verdict: Right")

    // Level 2 for display: the right answer scored 1, the wrong one and the "I don't know" 0, and none counts for memory.
    const rows = await withPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
      return prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'reader', assistance: 2 }, orderBy: { createdAt: 'asc' }, select: { score: true, confidence: true, metadata: true } })
    })
    expect(rows.map((row) => row.score)).toEqual([0, 0, 1])
    expect(rows.every((row) => row.confidence === null)).toBe(true)
    expect((rows[1].metadata as { idk?: boolean }).idk).toBe(true)
  })
})
