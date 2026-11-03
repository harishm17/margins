import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { createCourse, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { expectClearOfTabBar, expectNoSidewaysScroll } from './helpers/overflow'
import { streamedPartsArrived } from './helpers/settle'
import { TUTOR_CONCEPT, addTutorConcept, lastReply, removeTutorTraces, say, seedTutorReading, settled } from './helpers/v31-tutors'

// Workstream T (spec 18.6): Ask's turn counter, the reader tutor's second turn and the voice moves, on the mock AI service.
const course = `/courses/${demoIds().course}`

test.describe('Ask explains after repeated non-attempts', () => {
  test.beforeAll(addTutorConcept)
  test.afterAll(removeTutorTraces)

  test("Ask explains after two I don't knows and shows a check card", async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, DEMO_EMAIL)
    await page.goto(`${course}/ask`, { waitUntil: 'networkidle' })

    // The first message gets a question back. The concept has no evidence, so it is in the support band: one turn without an attempt is enough.
    await say(page, `Explain ${TUTOR_CONCEPT.toLowerCase()}`)
    await expect(page.getByText(/What do you think this means\?/)).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await expect(page.getByRole('group', { name: 'Check yourself' })).toHaveCount(0)

    // The student does not know where to start: a short explanation, with a check card, instead of another question.
    await say(page, `Explain ${TUTOR_CONCEPT.toLowerCase()}, I don't know where to start`)
    const card = page.getByRole('group', { name: 'Check yourself' })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await settled(page)
    await expect(lastReply(page).getByText(/Here is the short version/)).toBeVisible()
    await expect(lastReply(page).getByText(/What do you think this means\?/)).toHaveCount(0)
    await expect(card.getByText('Say the idea back in your own words.')).toBeVisible()
    await expect(card.getByText('The answer', { exact: true })).toHaveCount(0)
    await page.setViewportSize({ width: 1440, height: 900 })
    await screenshotIfAsked(page, 'ask-explain-short-1440x900')
    await expectNoAxeViolations(page, 'ask: short explanation with a check card')

    // What was recorded: the explanation is level 3 on the concept, and the count started again.
    const rows = await withPrisma((prisma) =>
      prisma.evidenceEvent.findMany({
        where: { user: { email: DEMO_EMAIL }, concept: { name: TUTOR_CONCEPT, projectId: demoIds().course } },
        select: { source: true, assistance: true, score: true, itemKey: true },
      })
    )
    expect(rows.map((row) => [row.source, row.assistance, row.score])).toEqual([['ask_check', 3, 0]])
    expect(rows[0].itemKey).toMatch(/:explained$/)
    const threadId = new URL(page.url()).searchParams.get('thread')!
    const counted = await withPrisma((prisma) =>
      prisma.tutorState.findFirstOrThrow({ where: { scope: 'ask', scopeKey: threadId }, select: { understandNoAttempt: true } })
    )
    expect(counted.understandNoAttempt).toBe(0)
  })
})

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

  test('two I-can-not-parse taps give a plain restatement, and the fifth reply in a day is refused', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const { email, topicId, topicUrl, chunkIds } = await readerWorld(page, 'v31-reader-restate')
    await openReader(page, `${topicUrl}?view=read`)
    const passage = page.locator('[data-passage]').nth(2)
    for (let tap = 0; tap < 2; tap++) {
      await passage.getByRole('button', { name: /Explain this passage: passage 3/ }).click()
      await passage.getByRole('button', { name: "I can't parse any of it", exact: true }).click()
      await expect(passage.locator('[data-note="question"]')).toHaveCount(tap + 1)
    }
    // The first reply is an explanation; the second says the passage again in simpler words.
    await expect(passage.locator('[data-note="question"]').nth(0)).not.toContainText('mock restatement')
    await expect(passage.locator('[data-note="question"]').nth(1)).toContainText('mock restatement')
    await expectNoAxeViolations(page, 'reader: a restatement')

    // An instruction event on the passage's concepts, and the explanation's level 3.
    const events = await withPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
      return prisma.evidenceEvent.findMany({ where: { userId: user.id, source: 'instruction' }, select: { itemKey: true, assistance: true, weight: true } })
    })
    expect(events).toEqual([{ itemKey: `instruction:restatement:${chunkIds[2]}`, assistance: 3, weight: 0 }])

    // Four replies a passage a day: two more by the API, then the fifth is refused with its reason.
    const post = (take: string) => page.request.post(`/api/topics/${topicId}/reader-explain`, { data: { chunkId: chunkIds[2], take } })
    expect((await post('a third take on the passage')).status()).toBe(200)
    expect((await post('a fourth take on the passage')).status()).toBe(200)
    const fifth = await post('a fifth take on the passage')
    expect(fifth.status()).toBe(429)
    expect(JSON.stringify(await fifth.json())).toContain('four replies on this passage today')
    // Another passage is not affected.
    expect((await page.request.post(`/api/topics/${topicId}/reader-explain`, { data: { chunkId: chunkIds[0], take: 'a take on the first passage' } })).status()).toBe(200)
  })

  test('the answer box and the verdict on a phone: no sideways scroll, clear of the tab bar, no axe violations', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 390, height: 844 })
    const { topicUrl } = await readerWorld(page, 'v31-reader-phone')
    await openReader(page, `${topicUrl}?view=read`)
    const passage = page.locator('[data-passage]').nth(2)
    await passage.getByRole('button', { name: 'Margin notes' }).click()
    await passage.getByRole('button', { name: /Explain this passage: passage 3/ }).click()
    await passage.getByRole('textbox').fill('It says the table keeps a list in each bucket.')
    await passage.getByRole('button', { name: 'Ask the tutor' }).click()
    const form = passage.getByRole('form', { name: /Answer the check question on passage 3/ })
    await expect(form).toBeVisible()
    await form.getByLabel('Your answer').fill('Photosynthesis turns light into sugar.')
    await expectClearOfTabBar(page, form.getByRole('button', { name: 'Check my answer' }), 'Check my answer')
    await screenshotIfAsked(page, 'v31-reader-answer-box-390x844')
    await expectNoAxeViolations(page, 'reader: answer box, 390')
    await form.getByRole('button', { name: 'Check my answer' }).click()
    await expect(passage.locator('[data-note="answer"]').locator('[data-verdict="not_yet"]')).toHaveText("Tutor's verdict: Not yet")
    await expectClearOfTabBar(page, passage.getByRole('button', { name: "I don't know" }), "I don't know")
    await screenshotIfAsked(page, 'v31-reader-verdict-390x844')
    await expectNoSidewaysScroll(page, page.url())
    await expectNoAxeViolations(page, 'reader: verdict, 390')
  })
})
