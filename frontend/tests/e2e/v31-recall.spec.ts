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

})
