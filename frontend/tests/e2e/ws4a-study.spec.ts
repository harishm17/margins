import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { ZONE } from './helpers/loop'
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

