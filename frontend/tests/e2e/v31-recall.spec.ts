import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { streamedPartsArrived } from './helpers/settle'
import { ZONE } from './helpers/loop'
import { ANSWER, CLAIM_PAGES, PROMPT_0, recallWorld } from './helpers/v31-recall'

// Workstream R (spec 18): "I don't remember" and linked pointers on recall, the reader focus and the checks'
// drafts, the warm-up that expects misses, and the map and progress panels. The AI service runs on the mock
// provider. Set SCREENS_DIR to keep screenshots at both sizes.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const card = (page: Page, prompt = PROMPT_0) => page.getByRole('region', { name: prompt })
const box = (page: Page, prompt = PROMPT_0) => page.getByRole('textbox', { name: prompt })

test.describe('recall: I don\'t remember', () => {
  test('recall offers I don\'t remember beside the clarifying question', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await recallWorld(page, 'v31-idk-clarify')
    await page.goto(`${topicUrl}?view=recall`)
    // Beside Submit from the start.
    await expect(card(page).getByRole('button', { name: "I don't remember" })).toBeVisible()
    await expect(card(page).getByRole('button', { name: 'Check my answer' })).toBeVisible()

    // The grader cannot read this, so it asks: the way out is offered inside the question.
    await box(page).fill('the table xyzzy plugh the bucket maybe something')
    await card(page).getByRole('button', { name: 'Check my answer' }).click()
    await expect(card(page).getByText('Which part of the topic do you mean?')).toBeVisible()
    await expect(card(page).getByText('Not enough to grade yet')).toBeVisible()
    await expect(card(page).getByRole('button', { name: "I don't remember" })).toHaveCount(1)
    await screenshotIfAsked(page, 'v31r-recall-clarify-1440x900')
    await expectNoAxeViolations(page, 'recall clarifying question with I don\'t remember, 1440')

    await card(page).getByRole('button', { name: "I don't remember" }).click()
    const feedback = card(page).getByRole('region', { name: 'Feedback on your answer' })
    await expect(feedback).toBeVisible()
    await expect(feedback).toBeFocused()
  })

  test('I don\'t remember is an honest, recorded attempt with where to look', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl, userId, topicId, conceptIds } = await recallWorld(page, 'v31-idk-record')
    await page.goto(`${topicUrl}?view=recall`)

    let graderCalls = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith(`/api/topics/${topicId}/recall`)) graderCalls += 1
    })
    await card(page).getByRole('button', { name: "I don't remember" }).click()
    const feedback = card(page).getByRole('region', { name: 'Feedback on your answer' })
    await expect(feedback).toBeVisible()
    await expect(feedback).toBeFocused()
    expect(graderCalls).toBe(1)
    await expect(feedback.getByRole('heading', { name: 'Where to look' })).toBeVisible()
    await expect(feedback.getByText("That's fine. Here's where to look.")).toBeVisible()
    // One link per idea of the card, with its page.
    const links = feedback.getByTestId('recall-pointer')
    await expect(links).toHaveCount(2)
    await expect(links.nth(0)).toHaveText(`Look again at p. ${CLAIM_PAGES[0]}`)
    await expect(links.nth(1)).toHaveText(`Look again at p. ${CLAIM_PAGES[1]}`)
    // Help on request: the explanation is behind "More help".
    await expect(feedback.getByTestId('recall-explainer-link')).toBeHidden()
    await feedback.getByRole('button', { name: 'More help' }).click()
    await expect(feedback.getByTestId('recall-explainer-link')).toBeVisible()
    // Nothing red: a miss on recall is not an error.
    await screenshotIfAsked(page, 'v31r-recall-idk-1440x900')
    await expectNoAxeViolations(page, 'recall after I don\'t remember, 1440')
    await page.setViewportSize(PHONE)
    await screenshotIfAsked(page, 'v31r-recall-idk-390x844')
    await expectNoAxeViolations(page, 'recall after I don\'t remember, 390')

    await withPrisma(async (prisma) => {
      const events = await prisma.evidenceEvent.findMany({ where: { userId, source: 'recall' } })
      expect(events.map((e) => e.conceptId).sort()).toEqual([conceptIds[0], conceptIds[1]].sort())
      expect(events.every((e) => e.assistance === 1 && e.score === 0 && e.confidence === null)).toBe(true)
      const attempt = await prisma.recallAttempt.findFirstOrThrow({ where: { userId } })
      expect((attempt.result as { idk?: boolean }).idk).toBe(true)
      const progress = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId, userId } } })
      expect(progress.recallAt).not.toBeNull()
    })
  })

  test('missed pointer opens the reader at the passage', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl, userId, topicId, conceptIds, chunkIds } = await recallWorld(page, 'v31-idk-pointer')
    await page.goto(`${topicUrl}?view=recall`)
    await card(page).getByRole('button', { name: "I don't remember" }).click()
    const feedback = card(page).getByRole('region', { name: 'Feedback on your answer' })
    await expect(feedback).toBeVisible()

    // The second idea's passage is the second chunk: the link goes there.
    await feedback.getByTestId('recall-pointer').nth(1).click()
    await expect(page).toHaveURL(new RegExp(`view=read&focus=${conceptIds[1]}#chunk-${chunkIds[1]}$`))
    await expect(page.locator(`#passage-${chunkIds[1]}`)).toBeVisible()

    // Opening it was instruction on that idea.
    await withPrisma(async (prisma) => {
      const rows = await prisma.evidenceEvent.findMany({ where: { userId, topicId, source: 'instruction' } })
      expect(rows.map((r) => r.conceptId)).toEqual([conceptIds[1]])
      expect((rows[0].metadata as { kind?: string }).kind).toBe('pointer')
    })
  })

  test('recall text survives closing the tab', async ({ page, browser }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl, topicId } = await recallWorld(page, 'v31-draft')
    await page.goto(`${topicUrl}?view=recall`)
    const saved = page.waitForResponse((response) => response.url().includes('/api/drafts') && response.request().method() === 'PUT' && response.ok())
    await box(page).fill(ANSWER)
    await saved
    await expect(card(page).getByText('Saved', { exact: true })).toBeVisible()
    const state = await page.context().storageState()
    await page.close()

    // Another browser context has no sessionStorage: the text can only come from the server.
    const other = await browser.newContext({ storageState: state, timezoneId: ZONE, viewport: DESKTOP })
    const again = await other.newPage()
    await again.goto(`${topicUrl}?view=recall`)
    await expect(box(again)).toHaveValue(ANSWER)
    // Submitting deletes the draft.
    await card(again).getByRole('button', { name: 'Check my answer' }).click()
    await expect(card(again).getByRole('region', { name: 'Feedback on your answer' })).toBeVisible()
    await withPrisma(async (prisma) => {
      expect(await prisma.studyDraft.count({ where: { topicId, surface: 'recall' } })).toBe(0)
    })
    await other.close()
  })
})

// ------------------------------------------------------------------------------------------ the reader and the explainer

async function openReader(page: Page, url: string) {
  await page.goto(url)
  await streamedPartsArrived(page)
  await expect(page.locator('[data-passage] .md').first()).toBeVisible()
  const passages = await page.locator('[data-passage]').count()
  await expect(page.locator('[data-passage] .md')).toHaveCount(passages)
}

test.describe('reader focus', () => {
  test('focus opens the reader at the concept', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl, conceptIds, chunkIds } = await recallWorld(page, 'v31-focus')
    // Load factor's claim is on the last passage, far below the fold.
    await openReader(page, `${topicUrl}?view=read&focus=${conceptIds[2]}#chunk-${chunkIds[3]}`)
    const target = page.locator(`#passage-${chunkIds[3]}`)
    await expect(target).toBeInViewport({ ratio: 0.1 })
    // It is a scroll that got there: the top of the reading is out of sight.
    await expect(page.locator(`#passage-${chunkIds[0]}`)).not.toBeInViewport()
    await expect(target.locator('[data-focus]').getByText('Focus here')).toBeVisible()
    // Only the passages that hold the idea are marked.
    await expect(page.locator('[data-focus]')).toHaveCount(1)
    await screenshotIfAsked(page, 'v31r-reader-focus-1440x900')
    await expectNoAxeViolations(page, 'reader opened for an idea, 1440')
    await page.setViewportSize(PHONE)
    await screenshotIfAsked(page, 'v31r-reader-focus-390x844')
    await expectNoAxeViolations(page, 'reader opened for an idea, 390')
  })

  test('focus without an address fragment finds the passage from the idea', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl, conceptIds, chunkIds } = await recallWorld(page, 'v31-focus-nohash')
    await openReader(page, `${topicUrl}?view=read&focus=${conceptIds[1]}`)
    // Collision has claims on the second and third passages; the reader opens at the first of them.
    await expect(page.locator(`#passage-${chunkIds[1]}`)).toBeInViewport({ ratio: 0.1 })
    await expect(page.locator('[data-focus]')).toHaveCount(2)
  })

  test('reader check answer survives a reload', async ({ page, browser }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl, userId } = await recallWorld(page, 'v31-check-draft')
    await openReader(page, `${topicUrl}?view=read`)
    const check = page.locator('[data-check]').first()
    const saved = page.waitForResponse((response) => response.url().includes('/api/drafts') && response.request().method() === 'PUT' && response.ok())
    await check.getByRole('textbox').fill('It sends a key to a bucket.')
    await saved
    await expect(check.getByText('Saved', { exact: true })).toBeVisible()

    // A reload with nothing in the tab's storage: the text comes from the server.
    await page.evaluate(() => window.sessionStorage.clear())
    await page.reload()
    await expect(page.locator('[data-check]').first().getByRole('textbox')).toHaveValue('It sends a key to a bucket.')

    // Another device: a new context with the same sign-in.
    const state = await page.context().storageState()
    const other = await browser.newContext({ storageState: state, timezoneId: ZONE, viewport: DESKTOP })
    const again = await other.newPage()
    await openReader(again, `${topicUrl}?view=read`)
    await expect(again.locator('[data-check]').first().getByRole('textbox')).toHaveValue('It sends a key to a bucket.')

    // Showing the source is kept too; grading deletes the draft.
    await again.locator('[data-check]').first().getByRole('button', { name: 'Show the source' }).click()
    await expect(again.locator('[data-check]').first().getByText('In your file')).toBeVisible()
    await again.reload()
    await expect(again.locator('[data-check]').first().getByText('In your file')).toBeVisible()
    await again.locator('[data-check]').first().getByRole('button', { name: 'Got it' }).click()
    await expect(again.locator('[data-check]').first().getByText('Saved: Got it')).toBeVisible()
    // This student's drafts only: the database is shared with every other spec, and some of them leave a reader check answer behind.
    await withPrisma(async (prisma) => {
      await expect.poll(() => prisma.studyDraft.count({ where: { userId, surface: 'reader_check' } })).toBe(0)
    })
    await other.close()
  })
})

test.describe('warm-up', () => {
  test('warm-up results say misses are expected', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl, userId, topicId } = await recallWorld(page, 'v31-warmup', { warmup: true, readAt: false })
    await page.goto(`${topicUrl}?view=warmup`)
    await page.getByRole('button', { name: 'Start warm-up' }).click()
    await expect(page.getByRole('heading', { name: 'Warm-up question 1 of 3' })).toBeVisible()
    await screenshotIfAsked(page, 'v31r-warmup-question-1440x900')
    await expectNoAxeViolations(page, 'warm-up question with I don\'t know, 1440')

    // "I don't know" on the first question needs no option and no confidence, and the next one comes easier.
    await page.getByTestId('warmup-idk').click()
    await expect(page.getByRole('heading', { name: 'Warm-up question 2 of 3' })).toBeVisible()
    await page.getByRole('radio').nth(1).click()
    await page.getByRole('radio', { name: 'Fairly sure' }).click()
    await page.getByRole('button', { name: 'Next question' }).click()
    await expect(page.getByRole('heading', { name: 'Warm-up question 3 of 3' })).toBeVisible()
    await page.getByTestId('warmup-idk').click()

    await expect(page.getByRole('heading', { name: 'Warm-up done' })).toBeVisible()
    await expect(page.getByText("You haven't read this yet, so misses here are expected. They mark where to look.")).toBeVisible()
    await expect(page.getByText("I don't know", { exact: true })).toHaveCount(2)
    // No red mark on a pretest, and no offer to skip the topic after "I don't know".
    await expect(page.locator('section[aria-labelledby="warmup-done-heading"] .text-danger')).toHaveCount(0)
    await expect(page.getByText('You may know this already')).toHaveCount(0)
    await screenshotIfAsked(page, 'v31r-warmup-results-1440x900')
    await expectNoAxeViolations(page, 'warm-up results with misses, 1440')
    await page.setViewportSize(PHONE)
    await screenshotIfAsked(page, 'v31r-warmup-results-390x844')
    await expectNoAxeViolations(page, 'warm-up results with misses, 390')

    await withPrisma(async (prisma) => {
      const events = await prisma.evidenceEvent.findMany({ where: { userId, topicId, source: 'warmup' } })
      expect(events.filter((e) => (e.metadata as { idk?: boolean }).idk === true).every((e) => e.score === 0 && e.confidence === null)).toBe(true)
      expect(events.filter((e) => (e.metadata as { idk?: boolean }).idk === true).length).toBeGreaterThan(0)
      expect((await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId, userId } } })).warmupAt).not.toBeNull()
    })
    // Said once a day: a reload of the results does not repeat it.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Warm-up done' })).toBeVisible()
    await expect(page.getByText("You haven't read this yet")).toHaveCount(0)
  })
})

test.describe('explainer', () => {
  test('the full explainer opens at the section that names the idea, and reading it is instruction', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl, conceptIds, userId, topicId } = await recallWorld(page, 'v31-explainer-focus', { recallAt: true })
    const instruction = (conceptId: string) => withPrisma((prisma) => prisma.evidenceEvent.count({ where: { userId, topicId, source: 'instruction', conceptId } }))
    await page.goto(`${topicUrl}?view=explainer&focus=${conceptIds[2]}`)
    await streamedPartsArrived(page)
    await expect(page.locator('#main').getByRole('heading', { name: 'Load factor', level: 2 })).toBeInViewport({ ratio: 0.5 })
    await expect.poll(() => instruction(conceptIds[2])).toBe(1)
    // A section read without the address naming it is instruction on the idea its heading names, once per day.
    await page.goto(`${topicUrl}?view=explainer`)
    await streamedPartsArrived(page)
    await page.locator('#main').getByRole('heading', { name: 'Collision', level: 2 }).scrollIntoViewIfNeeded()
    await expect.poll(() => instruction(conceptIds[1])).toBe(1)
    await page.reload()
    await streamedPartsArrived(page)
    await page.locator('#main').getByRole('heading', { name: 'Collision', level: 2 }).scrollIntoViewIfNeeded()
    await page.waitForLoadState('networkidle')
    expect(await instruction(conceptIds[1])).toBe(1)
  })

  test('the explainer gate says "I\'d rather read an explanation now"', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    const { topicUrl } = await recallWorld(page, 'v31-gate')
    await page.goto(`${topicUrl}?view=explainer`)
    await expect(page.getByRole('button', { name: "I'd rather read an explanation now" })).toBeEnabled()
    await expect(page.getByRole('button', { name: /The pages don't explain this well/ })).toHaveCount(0)
    await screenshotIfAsked(page, 'v31r-explainer-gate-1440x900')
    await expectNoAxeViolations(page, 'explainer gate, 1440')
    await page.setViewportSize(PHONE)
    await screenshotIfAsked(page, 'v31r-explainer-gate-390x844')
  })
})
