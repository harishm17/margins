import { test, expect } from './harness/fixtures'
import { chooseFiles, confirmTopics, createCourse, FILES, newStudent, openUploadArea, waitForTopics } from './harness/course'
import { cutOffText, expectNone, repeatedSentences } from './harness/page-checks'
import { estimateProblems, settled, type Moment, type Row, type Watched } from './harness/uploads'
import type { Page } from '@playwright/test'

// WF1: a new course. Sign up, upload a batch (two lecture PDFs, a slide deck and a scan), wait for the topics, add a
// past exam, meet the duplicate dialog, check the topics (rename, merge) and confirm.

/** The file rows of the upload list on the page that is open, in the order shown. */
async function fileRows(page: Page): Promise<Row[]> {
  return page.locator('main table tbody tr').evaluateAll((rows) =>
    rows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim().replace(/\s+/g, ' '))
      return { name: cells[0] ?? '', status: cells[3] ?? '' }
    })
  )
}

const shortName = (row: Row) => Object.values(FILES).find((file) => row.name.includes(file)) ?? row.name

/** Watches the upload list every half second until each of `files` has settled (ready, or a problem it explains). */
async function watchUploads(page: Page, files: string[], started: number): Promise<Moment[]> {
  const moments: Moment[] = []
  for (;;) {
    await openUploadArea(page)
    const rows = await fileRows(page)
    moments.push({ at: Date.now() - started, rows, cutOff: await cutOffText(page.locator('main table')) })
    const mine = files.map((file) => rows.find((row) => row.name.includes(file)))
    if (mine.every((row) => row !== undefined && settled(row.status))) return moments
    expect(Date.now() - started, `still being read: ${JSON.stringify(rows)}`).toBeLessThan(5 * 60_000)
    await page.waitForTimeout(500)
  }
}

test('WF1 new course: upload a batch, the duplicate dialog, the topic check, confirm', async ({ page, checks }) => {
  await newStudent(page, 'WF1')
  const { courseUrl } = await createCourse(page)

  const batch = [FILES.lecture1, FILES.lecture2, FILES.slides, FILES.scan]
  const watched: Watched[] = []

  await test.step('upload the batch and watch it being read', async () => {
    const started = Date.now()
    await chooseFiles(page, batch)
    const moments = await watchUploads(page, batch, started)
    watched.push(...batch.map((file) => ({ file, earlierDone: false, moments })))
  })
  await checks.check('WF1.scan-explained', 'the scan says why it cannot be used and how to fix it', async () => {
    await openUploadArea(page)
    const scan = page.locator('main table tbody tr', { hasText: FILES.scan })
    await expect(scan, 'why').toContainText(/scanned|no text/i)
    await expect(scan, 'how to fix it').toContainText(/text-based PDF|run OCR/i)
    await expect(page.getByRole('button', { name: /^Remove .*failed file/ }), 'a way to remove it').toBeVisible()
  })

  // The past exam goes in once the topics are found: one added while topic finding is about to start may or may not be
  // in its prompt, and the recorded answers are matched by prompt.
  await test.step('wait for the topics', async () => {
    await waitForTopics(page, courseUrl)
  })

  await test.step('add the past exam and watch it being read', async () => {
    const started = Date.now()
    await chooseFiles(page, [FILES.pastExam], 'Past exams')
    watched.push({ file: FILES.pastExam, earlierDone: true, moments: await watchUploads(page, [FILES.pastExam], started) })
  })

  const moments = watched.flatMap((upload) => upload.moments)
  await checks.check('WF1.upload-status-not-cut-off', 'the upload list never cuts off a status or file name without its full text (SW6)', () => {
    expectNone([...new Set(moments.flatMap((moment) => moment.cutOff))], 'cut off')
  })
  await checks.check('WF1.upload-status-says-something', 'every row shows a status in words at every moment (SW7)', () => {
    const blank = moments.flatMap((moment) => moment.rows.filter((row) => !row.status).map((row) => `${shortName(row)} at ${moment.at} ms`))
    expectNone([...new Set(blank)], 'rows with no status')
  })
  await checks.check('WF1.upload-estimate-honest', 'an upload estimate is kept or the status says the file is late; long waits give one (SW7)', () => {
    expectNone(watched.flatMap(estimateProblems), 'estimates')
  })

  await test.step('the duplicate dialog: the same lecture again, cancelled', async () => {
    await openUploadArea(page)
    const before = (await fileRows(page)).length
    await chooseFiles(page, [FILES.lecture1])
    const dialog = page.getByRole('dialog', { name: 'This file is already here' })
    await expect(dialog).toBeVisible()
    await checks.check('WF1.duplicate-dialog-consequence', 'the duplicate dialog says what adding it again would do', async () => {
      await expect(dialog).toContainText(/read it a second time|another topic review/)
    })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect((await fileRows(page)).length).toBe(before)
  })

  const order = { setup: [] as string[], materials: [] as string[] }
  await test.step('the setup page with every file in', async () => {
    await waitForTopics(page, courseUrl)
    await openUploadArea(page)
    order.setup = (await fileRows(page)).map(shortName)
  })
  await checks.check('WF1.setup-says-once', 'the setup page says each thing once (SW15)', async () => {
    expectNone(await repeatedSentences(page.locator('main')), 'repeated on the setup page')
  })

  await test.step('the Materials page', async () => {
    await page.goto(`${courseUrl}/materials`)
    await expect(page.getByRole('heading', { level: 1, name: 'Materials' })).toBeVisible()
    order.materials = (await fileRows(page)).map(shortName)
  })
  await checks.check('WF1.file-order', 'the files are listed in the order they were added, on the setup page and on Materials (F6)', () => {
    const added = [...batch, FILES.pastExam]
    expect(order.setup, `setup page: ${order.setup.join(', ')}`).toEqual(added)
    expect(order.materials, `Materials page: ${order.materials.join(', ')}`).toEqual(added)
  })

  await test.step('the topic check: rename one topic and merge another into it', async () => {
    await page.goto(`${courseUrl}/topics`)
    await expect(page.getByRole('heading', { level: 1, name: 'Check the topics' })).toBeVisible()
    const rows = page.getByRole('list', { name: /^Topics/ }).getByRole('listitem')
    const count = await rows.count()
    expect(count, 'topics found').toBeGreaterThanOrEqual(3)

    await checks.check('WF1.one-rename-pattern', 'a topic row has no repeated "Rename" text: the name is the edit control (U6)', async () => {
      await expect(page.locator('main').getByRole('button').filter({ hasText: /^\s*Rename\s*$/ })).toHaveCount(0)
    })

    await rows.first().getByRole('button', { name: /^Rename / }).click()
    const nameInput = page.getByLabel('Topic name').locator('visible=true')
    await nameInput.fill('Algorithms and their cost')
    await nameInput.press('Enter')
    await expect(rows.first().getByRole('button', { name: 'Rename Algorithms and their cost' })).toBeVisible()

    const last = rows.nth(count - 1)
    const lastName = ((await last.getByRole('button', { name: /^Actions for / }).getAttribute('aria-label')) ?? '').replace(/^Actions for /, '')
    await last.getByRole('button', { name: /^Actions for / }).click()
    await page.getByRole('menuitem', { name: 'Merge into...' }).click()
    await page.getByRole('menuitem', { name: 'Algorithms and their cost' }).click()
    await expect(page.getByRole('dialog')).toContainText(`Merge ${lastName} into Algorithms and their cost?`)
    await page.getByRole('button', { name: 'Merge topics' }).click()
    await expect(rows).toHaveCount(count - 1)
  })

  await test.step('confirm', async () => {
    await confirmTopics(page, courseUrl)
  })
  await checks.check('WF1.start-studying-says-once', 'the last setup step says each thing once (SW15)', async () => {
    expectNone(await repeatedSentences(page.locator('main')), 'repeated on the start step')
  })
})
