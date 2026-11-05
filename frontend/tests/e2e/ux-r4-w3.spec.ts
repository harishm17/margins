import { expect, test } from '@playwright/test'
import { FIXTURE_PDF } from './helpers/seed-demo'
import { withPrisma } from './helpers/db'
import { addContent, addFileRow, createCourse, createEmptyCourse, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// Round 4, workstream W3: course setup, Materials, the topic editor, the Plan, Home, the Overview and the Topics list.

test.use({ timezoneId: ZONE })
test.setTimeout(120_000)

test.describe('materials', () => {
  test('the kind of file is chosen before the files are, at both widths', async ({ page }) => {
    await signUpAndIn(page, 'r4w3-role', { own: true })
    const courseId = await createEmptyCourse(page, 'Role course')
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport)
      await page.goto(`/courses/${courseId}/materials`)
      const group = page.getByRole('radiogroup', { name: 'These files are:' })
      await expect(group).toBeVisible()
      // A default is already chosen, so nothing has to be decided first.
      await expect(group.getByRole('radio', { name: 'Lecture notes', checked: true })).toBeVisible()
      await expect(page.getByText('Exam papers or practice tests.')).toHaveCount(0)
      await group.getByRole('radio', { name: 'Past exams' }).click()
      await expect(page.getByText('Exam papers or practice tests.', { exact: false })).toBeVisible()
      // The group comes before the button that opens the picker.
      const button = viewport.width < 640 ? page.getByRole('button', { name: 'Choose files', exact: true }) : page.getByRole('button', { name: 'browse' })
      const [groupBox, buttonBox] = [await group.boundingBox(), await button.boundingBox()]
      expect(groupBox!.y).toBeLessThan(buttonBox!.y)
    }
  })

  test('a refused file at 390px reads in normal lines with its button below, and dismissing says it was never stored', async ({ page }) => {
    await signUpAndIn(page, 'r4w3-refused', { own: true })
    await page.setViewportSize({ width: 390, height: 844 })
    const courseId = await createEmptyCourse(page, 'Refused course')
    await page.goto(`/courses/${courseId}/materials`)
    await page.locator('input[type=file]').setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }])
    const alert = page.getByRole('alert').filter({ hasText: /need attention|needs attention/ })
    await expect(alert).toBeVisible()
    const message = alert.locator('[aria-live="polite"]')
    const action = alert.getByRole('button', { name: 'Dismiss failed upload' })
    const [text, button] = [await message.boundingBox(), await action.boundingBox()]
    // The message keeps the width of the alert (not a narrow column) and the button sits under it, full width.
    expect(text!.width).toBeGreaterThan(250)
    expect(button!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1)
    expect(button!.width).toBeGreaterThan(250)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await action.click()
    await expect(page.getByRole('dialog').getByText('nothing was saved')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Dismiss failed upload' }).click()
    await expect(page.getByRole('row', { name: /notes\.txt/ })).toHaveCount(0)
  })

  test('deleting a file leaves a status line after the toast, and replacing is offered in the dialog', async ({ page }) => {
    const { email } = await signUpAndIn(page, 'r4w3-delete', { own: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    const { courseId, topics } = await createCourse(page, 'Delete course', [{ name: 'Sorting' }])
    const material = await withPrisma((prisma) => prisma.material.findFirstOrThrow({ where: { projectId: courseId } }))
    await withPrisma((prisma) =>
      prisma.topicSource.create({ data: { topicId: topics.Sorting, materialId: material.id, pageStart: 1, pageEnd: 4, chunkIndexStart: 0, chunkIndexEnd: 3 } })
    )
    expect(email).toContain('@')
    await page.goto(`/courses/${courseId}/materials`)
    await page.getByRole('button', { name: `Actions for ${material.filename}` }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Existing topic content stays. Links to this file from Ask answers and notes will stop opening.')).toBeVisible()
    await expect(dialog.getByText('View affected topics (1)')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Replace this file instead' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete file' }).click()
    const notice = page.getByTestId('materials-notice')
    await expect(notice).toContainText(`Deleted ${material.filename}`)
    await expect(notice).toContainText('1 topic can no longer open links to it')
    await expect(notice.getByRole('link', { name: 'Review topics' })).toHaveAttribute('href', `/courses/${courseId}/topics?edit=1`)
    // It stays after the toast has gone.
    await page.waitForTimeout(6500)
    await expect(notice).toBeVisible()
    // The next material action replaces it.
    await page.getByLabel('Choose files to upload').setInputFiles(FIXTURE_PDF)
    await expect(page.getByTestId('materials-notice')).toHaveCount(0)
  })

  test('Replace this file instead swaps the file and says so', async ({ page }) => {
    await signUpAndIn(page, 'r4w3-replace', { own: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    const { courseId } = await createCourse(page, 'Replace course', [{ name: 'Sorting' }])
    const material = await withPrisma((prisma) => prisma.material.findFirstOrThrow({ where: { projectId: courseId } }))
    await page.goto(`/courses/${courseId}/materials`)
    await page.getByRole('button', { name: `Actions for ${material.filename}` }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('dialog').getByRole('button', { name: 'Replace this file instead' }).click()
    await (await chooser).setFiles(FIXTURE_PDF)
    const notice = page.getByTestId('materials-notice')
    await expect(notice).toContainText(`Replaced ${material.filename} with algorithms.pdf`, { timeout: 30_000 })
    await expect(page.getByRole('row', { name: new RegExp(material.filename.replace('.', '\\.')) })).toHaveCount(0)
  })
})

test.describe('topic editor', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('says Saving, All changes saved, and what failed with Retry; the row is put back', async ({ page }) => {
    await signUpAndIn(page, 'r4w3-save', { own: true })
    const { courseId } = await createCourse(page, 'Save status course', [{ name: 'Alpha' }, { name: 'Beta' }])
    await page.goto(`/courses/${courseId}/topics?edit=1`)
    const status = page.getByTestId('save-status')
    await expect(status).toHaveText('')
    // A failed rename: the row goes back and the status offers Retry.
    await page.route('**/api/topics/*', (route) => (route.request().method() === 'PATCH' ? route.abort() : route.continue()))
    await page.getByRole('button', { name: 'Rename Alpha' }).click()
    await page.getByRole('textbox', { name: 'Topic name' }).fill('Alpha renamed')
    await page.keyboard.press('Enter')
    await expect(status).toContainText('Couldn\'t save "Alpha renamed"')
    await expect(page.getByText('Alpha renamed', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible()
    // With the connection back, Retry sends the same change.
    await page.unroute('**/api/topics/*')
    await status.getByRole('button', { name: 'Retry' }).click()
    await expect(status).toHaveText('All changes saved')
    await expect(page.getByText('Alpha renamed', { exact: true })).toBeVisible()
  })

  test('one Add button, Rename visible and the other commands in one row menu', async ({ page }) => {
    await signUpAndIn(page, 'r4w3-add', { own: true })
    const { courseId } = await createCourse(page, 'Add course', [{ name: 'Alpha' }])
    await page.goto(`/courses/${courseId}/topics?edit=1`)
    const add = page.getByRole('button', { name: 'Add', exact: true })
    await expect(add).toBeDisabled()
    await page.getByLabel('Add a topic').fill('Gamma')
    await add.click()
    await expect(page.getByRole('listitem').filter({ hasText: 'Gamma' })).toBeVisible()
    const row = page.getByRole('listitem').filter({ hasText: 'Alpha' }).first()
    await expect(row.getByRole('button', { name: 'Rename Alpha' })).toBeVisible()
    await row.getByRole('button', { name: 'Actions for Alpha' }).click()
    for (const name of ['Move up', 'Move down', 'Merge into...', 'Delete']) await expect(page.getByRole('menuitem', { name })).toBeVisible()
  })

  test('"Taught from" links open the original file at the cited page', async ({ page }) => {
    await signUpAndIn(page, 'r4w3-sources', { own: true })
    const { courseId, topics } = await createCourse(page, 'Sources course', [{ name: 'Sorting' }])
    const material = await withPrisma((prisma) => prisma.material.findFirstOrThrow({ where: { projectId: courseId } }))
    await withPrisma((prisma) =>
      prisma.topicSource.create({ data: { topicId: topics.Sorting, materialId: material.id, pageStart: 1, pageEnd: 4, chunkIndexStart: 0, chunkIndexEnd: 3 } })
    )
    await page.goto(`/courses/${courseId}/topics?edit=1`)
    const link = page.getByRole('link', { name: /pp\. 1-4/ })
    await expect(link).toHaveAttribute('href', `/api/materials/${material.id}/file#page=1`)
    await expect(link).toHaveAttribute('target', '_blank')
  })

  test('on a phone a row keeps the name, the sources and Rename; the description waits behind Details', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signUpAndIn(page, 'r4w3-phone-row', { own: true })
    const { courseId, topics } = await createCourse(page, 'Phone rows course', [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }])
    await withPrisma((prisma) => prisma.topic.update({ where: { id: topics.Alpha }, data: { description: 'A long description of the first topic that would push the rows down' } }))
    await page.goto(`/courses/${courseId}/topics?edit=1`)
    const row = page.getByRole('listitem').filter({ hasText: 'Alpha' }).first()
    await expect(row.getByText('A long description')).toBeHidden()
    await row.getByRole('button', { name: 'Show details of Alpha' }).click()
    await expect(row.getByText('A long description')).toBeVisible()
    // Three topics fit in about a screen and a half.
    const list = await page.getByRole('list', { name: 'Topics' }).boundingBox()
    expect(list!.height).toBeLessThan(844 * 1.5)
  })
})

test.describe('plan, topics list, home and overview', () => {
  test('a rolling plan shows at most one empty row between days that have something', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'r4w3-plan', { own: true })
    const { courseId } = await createCourse(page, 'Plan course', [{ name: 'Alpha', minutes: 30 }])
    await page.goto(`/courses/${courseId}/plan`)
    await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
    const runs = page.getByRole('listitem').filter({ has: page.getByText('Show every day') }).filter({ hasNot: page.getByRole('listitem').filter({ has: page.getByText('Show every day') }) })
    // However many days are empty, each stretch of them is one row with the way to fill it.
    // Two empty rows never follow each other: a stretch of empty days is always one row.
    const adjacent = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('li')].filter((li) => li.querySelector(':scope > details > summary')?.textContent?.includes('Show every day'))
      return rows.filter((row) => rows.includes(row.nextElementSibling as HTMLLIElement)).length
    })
    expect(adjacent).toBe(0)
    if ((await runs.count()) > 0) {
      await expect(runs.first().getByRole('link', { name: 'Set an exam date' })).toHaveAttribute('href', `/courses/${courseId}/settings`)
      await runs.first().getByText('Show every day').click()
      await expect(runs.first().getByRole('listitem').first()).toContainText('Nothing planned yet')
    }
  })

  test('Topics list at 390px: the long name and the next step are fully readable and nothing overflows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signUpAndIn(page, 'r4w3-topics', { own: true })
    const { courseId, topics } = await createCourse(page, 'Topics phone course', [{ name: 'Sorting algorithms and their running time' }])
    await addContent(topics['Sorting algorithms and their running time'], { section_notes: '# Sorting\n\nNotes.' })
    await page.goto(`/courses/${courseId}/topics`)
    const name = page.getByRole('list', { name: 'Topics' }).getByText('Sorting algorithms and their running time', { exact: true })
    await expect(name).toBeVisible()
    const clipped = await name.evaluate((el) => (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 1 || (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1)
    expect(clipped).toBe(false)
    const next = page.getByText(/^Next: /).first()
    await expect(next).toBeVisible()
    expect(await next.evaluate((el) => (el as HTMLElement).scrollWidth <= (el as HTMLElement).clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })

  test('Home: a returning student has one filled primary and a count line instead of squares', async ({ page, context }) => {
    await setZoneCookie(context)
    await page.setViewportSize({ width: 1440, height: 900 })
    await signUpAndIn(page, 'r4w3-home', { own: true })
    const { courseId } = await createCourse(page, 'Home count course', [{ name: 'Alpha' }, { name: 'Beta' }])
    await page.goto('/home')
    await expect(page.getByText('One square per topic:')).toHaveCount(0)
    await expect(page.locator('[role="img"][aria-label^="Topic mastery"]')).toHaveCount(0)
    const newCourse = page.getByRole('link', { name: 'New course' })
    // Secondary, not the filled accent button.
    expect(await newCourse.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await page.getByRole('link', { name: /Start|Continue|Open/ }).first().evaluate((el) => getComputedStyle(el).backgroundColor))
    // The course card carries one line of status (here the setup step), not a strip of squares.
    await expect(page.locator(`a[href="/courses/${courseId}"]`).filter({ hasText: 'Home count course' }).last()).toBeVisible()
  })

  test('Overview on a phone: header, the exam-date line, Up next, then Topics', async ({ page, context }) => {
    await setZoneCookie(context)
    await page.setViewportSize({ width: 390, height: 844 })
    await signUpAndIn(page, 'r4w3-overview', { own: true })
    const empty = await createEmptyCourse(page, 'Overview order')
    await addFileRow(empty)
    const { courseId, topics } = await createCourse(page, 'Overview order', [{ name: 'Sorting', minutes: 30 }, { name: 'Searching', minutes: 30 }], { existingCourseId: empty })
    await addContent(topics.Sorting, { section_notes: '# Sorting\n\nNotes.' })
    await page.goto(`/courses/${courseId}`)
    const [h1, exam, upNext, topicsHeading] = await Promise.all([
      page.getByRole('heading', { level: 1 }).boundingBox(),
      page.getByRole('region', { name: 'When is your exam?' }).boundingBox(),
      page.getByRole('region', { name: 'Up next' }).boundingBox(),
      page.getByRole('heading', { level: 2, name: 'Topics' }).boundingBox(),
    ])
    expect(h1!.y).toBeLessThan(exam!.y)
    expect(exam!.y).toBeLessThan(upNext!.y)
    expect(upNext!.y).toBeLessThan(topicsHeading!.y)
    // The title names the activity, not "Learn <topic>".
    await expect(page.getByRole('region', { name: 'Up next' })).not.toContainText('Start learning')
  })
})
