import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
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
