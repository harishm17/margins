import type { Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { withPrisma } from '../e2e/helpers/db'
import { DAILY_LIMIT_USD, allowanceStateGaps, inPlainTerms, minutesToReset, overshoot, spendSince, spendUpTo, topicJobsSettled } from './harness/allowance'
import { FILES, chooseFiles, openOnWarmup, readyCourse, startStudying, takeWarmup } from './harness/course'
import { preparationFinished } from './harness/files'
import { expectNone } from './harness/page-checks'
import { missingParts } from './harness/regenerate'

// WF9: the allowance, worked up to the limit. A student studies a topic, reads Settings and the Prepare all dialog,
// opens three new topics at once with a cent of the day left, then visits every surface that calls the AI once the
// day is used, and uploads a scan. The day's earlier studying is one ledger row the workflow adds; the rest is real.

/** What is left of the day when the three topics open: less than any one job costs. */
const LAST_CENT = 0.01

/** The page's main text, or a dialog's, on one line. */
async function textOf(page: Page, selector = 'main'): Promise<string> {
  return (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ').trim()
}

/**
 * Waits until the topic finding started by an upload after `since` has ended (done, or refused), or a minute has gone by
 * with none started.
 */
async function topicFindingSettled(courseId: string, since: Date): Promise<void> {
  const began = Date.now()
  for (;;) {
    const jobs = await withPrisma((prisma) =>
      prisma.processingJob.findMany({ where: { projectId: courseId, jobType: 'extract_topics', createdAt: { gte: since } }, select: { status: true } })
    )
    const running = jobs.some((job) => job.status === 'pending' || job.status === 'processing')
    if (!running && (jobs.length > 0 || Date.now() - began > 60_000)) return
    if (Date.now() - began > 5 * 60_000) throw new Error('Topic finding was still running after 5 min')
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

/** Waits until the app tells the browser the student's allowance is used (its status is cached for a few seconds). */
async function allowanceUsedShown(page: Page): Promise<void> {
  await expect
    .poll(async () => ((await (await page.request.get('/api/ai-status')).json()) as { blocked: string | null }).blocked, { timeout: 30_000, intervals: [2000] })
    .toBe('LLM_DAILY_BUDGET')
}

test('WF9 allowance: work up to the limit, then every surface past it', async ({ page, checks }) => {
  test.setTimeout(20 * 60_000)
  const toReset = minutesToReset()
  if (toReset < 25) throw new Error(`The allowance resets at midnight UTC in ${Math.round(toReset)} min, inside this run. Run WF9 after midnight UTC.`)

  const { courseUrl, courseId, email } = await readyCourse(page, 'WF9')
  await startStudying(page, courseUrl)
  const topicUrl = new URL(page.url()).pathname
  const topicId = topicUrl.split('/').pop()!

  await test.step('a studied topic, prepared to its end', async () => {
    await openOnWarmup(page, topicUrl)
    await takeWarmup(page)
    await preparationFinished(topicId)
  })

  await test.step('under the limit: Settings and the Prepare all dialog', async () => {
    await page.goto('/settings')
    const summary = (await page.getByTestId('allowance-summary').innerText()).replace(/\s+/g, ' ').trim()
    console.log(`Settings, under the limit: "${summary}"`)
    await checks.check('WF9.settings-plain-terms', 'Settings says what is left of today in plain terms, not only a percent (D2, 77)', () =>
      expect(inPlainTerms(summary), `"${summary}"`).toBe(true)
    )

    await page.goto(courseUrl)
    await page.getByRole('button', { name: 'Course actions' }).click()
    await page.getByRole('menuitem', { name: 'Prepare all topics now' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Prepare all topics now?' }).or(page.getByRole('dialog', { name: 'Prepare all topics now?' }))
    const said = (await dialog.innerText()).replace(/\s+/g, ' ').trim()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await checks.check('WF9.prepare-all-says-share', "the Prepare all dialog says about how long it takes and its share of today's allowance (X4, 77)", () =>
      expectNone(missingParts(said).filter((part) => part !== 'what is kept'), `"${said}"`)
    )
  })

  const otherTopics = await withPrisma(async (prisma) =>
    (await prisma.topic.findMany({ where: { projectId: courseId, userConfirmed: true }, orderBy: { orderIndex: 'asc' }, select: { id: true } }))
      .map((topic) => topic.id)
      .filter((id) => id !== topicId)
  )
  let refusedTopic = ''
  await test.step('with a cent of the day left, three new topics opened at once', async () => {
    const since = await spendUpTo(email, DAILY_LIMIT_USD - LAST_CENT)
    const tabs = await Promise.all(otherTopics.map(() => page.context().newPage()))
    await Promise.all(tabs.map((tab, index) => tab.goto(`${courseUrl}/topics/${otherTopics[index]}`)))
    await topicJobsSettled(otherTopics, since)
    await Promise.all(tabs.map((tab) => tab.close()))
    refusedTopic = `${courseUrl}/topics/${otherTopics[0]}`

    const costs = (await spendSince(email, since)).map((row) => row.cost)
    const { over, moreThanOneJob } = overshoot(DAILY_LIMIT_USD - LAST_CENT, costs, DAILY_LIMIT_USD)
    console.log(`${costs.length} model-calling jobs ran on the last cent, ${over.toFixed(2)} past the limit`)
    await checks.check('WF9.one-job-past-limit', 'work started together on the last of the allowance stops within one job of the limit (S2, K4)', () =>
      expect(moreThanOneJob, `${costs.length} jobs ran on the last cent`).toBe(false)
    )
  })

  // However the jobs went, the day is used from here on.
  const usedAt = await spendUpTo(email, DAILY_LIMIT_USD)
  await allowanceUsedShown(page)

  const surfaces: [string, string][] = []
  await test.step('past the limit: every surface that calls the AI', async () => {
    await page.goto(refusedTopic)
    await page.waitForLoadState('networkidle')
    surfaces.push(['a new topic whose preparation was refused', await textOf(page)])

    await page.goto(`${courseUrl}/ask`)
    await page.waitForLoadState('networkidle')
    surfaces.push(['Ask', await textOf(page)])

    await page.goto(`${topicUrl}?view=practice`)
    // The tutor sits under "Get help" on each step.
    const help = page.getByRole('button', { name: /^(Get help|More help)$/ }).first()
    await expect(help).toBeVisible({ timeout: 60_000 })
    if ((await help.getAttribute('aria-expanded')) !== 'true') await help.click()
    surfaces.push(['the practice tutor', await textOf(page)])

    await page.goto(`${topicUrl}?view=recall`)
    await page.waitForLoadState('networkidle')
    surfaces.push(['recall', await textOf(page)])

    await page.goto(`${topicUrl}?view=voice`)
    await page.waitForLoadState('networkidle')
    surfaces.push(['voice practice', await textOf(page)])

    await page.goto(`${courseUrl}/exams/new`)
    await page.waitForLoadState('networkidle')
    surfaces.push(['a new practice exam', await textOf(page)])

    await page.goto(`${topicUrl}?view=read`)
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Regenerate notes' }).click()
    surfaces.push(['the regenerate dialog', await textOf(page, '[role="dialog"]')])
    await page.keyboard.press('Escape')

    await page.goto('/settings')
    await page.waitForLoadState('networkidle')
    surfaces.push(['Settings', await textOf(page)])
  })

  await test.step('past the limit: a scan and a set of slides uploaded to the course', async () => {
    const uploaded = new Date()
    await page.goto(`${courseUrl}/materials`)
    await chooseFiles(page, [FILES.scan, FILES.slides])
    const row = page.locator('main table tbody tr', { hasText: FILES.scan })
    await expect(row).toContainText(/Ready|Not usable/, { timeout: 3 * 60_000 })
    const rowText = (await row.innerText()).replace(/\s+/g, ' ').trim()
    console.log(`the scan, past the limit: "${rowText}"`)
    // The slides are read, and a new file in a confirmed course looks for topics again, which calls the AI.
    await expect(page.locator('main table tbody tr', { hasText: FILES.slides })).toContainText(/Ready|Not usable/, { timeout: 3 * 60_000 })
    await topicFindingSettled(courseId, uploaded)
    await page.reload()
    await page.waitForLoadState('networkidle')
    const onFiles = await textOf(page)
    await page.goto(courseUrl)
    await page.waitForLoadState('networkidle')
    surfaces.push(['topic finding after an upload', `${onFiles} ${await textOf(page)}`])
    await checks.check('WF9.scan-upload-not-failed', 'a scan uploaded past the limit is not marked as failed: reading pages never fails an upload (B4)', () =>
      expect(rowText).not.toMatch(/\bfailed\b|went wrong/i)
    )
  })

  for (const [surface, text] of surfaces) console.log(`${surface}: ${allowanceStateGaps(text).length ? 'missing ' + allowanceStateGaps(text).join(' and ') : 'the allowance state'}`)
  await checks.check('WF9.same-allowance-state', 'every surface that calls the AI shows the same "allowance reached" state, with when it resets (X4, D2, 77)', () =>
    expectNone(
      surfaces.flatMap(([surface, text]) => allowanceStateGaps(text).map((gap) => `${surface}: no ${gap}`)),
      'surfaces'
    )
  )

  // Checking an uploaded file is a small fixed cost that runs past the limit on purpose (K4): refusing it would refuse the upload.
  const spentPast = await spendSince(email, usedAt)
  const checking = spentPast.filter((row) => row.jobType === 'validate_material')
  console.log(`past the limit: ${checking.length} uploaded files checked, $${checking.reduce((sum, row) => sum + row.cost, 0).toFixed(4)}`)
  await checks.check('WF9.nothing-spent-past-limit', 'past the limit nothing calls the model but the check of an uploaded file: the surfaces, topic finding and reading a scan (K4, B4)', () =>
    expectNone(
      spentPast.filter((row) => row.jobType !== 'validate_material').map((row) => `${row.jobType ?? row.source}: ${row.cost}`),
      'spend after the limit'
    )
  )
})
