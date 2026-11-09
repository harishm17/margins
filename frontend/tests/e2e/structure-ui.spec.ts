import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { withPrisma } from './helpers/db'
import { DEMO_EMAIL, FIXTURE_PDF, demoIds } from './helpers/seed-demo'

// The course structure screens: units on the topics page and in the sidebar, the topic header
// (objectives, prerequisites, sources, time), "Check yourself", the sources under each example and
// practice problem, a multiple-choice practice step, the topic editor with units, and file roles.
// The first group only reads the shared demo course (two units and one topic outside any unit, see
// helpers/seed-demo.ts). The second builds its own account and course, because it changes things.

const { course, topics, mathTopic } = demoIds()
// getByText also sees the hidden copy Next keeps while a page streams in; the page body is one place only.
const body = (page: Page) => page.locator('#main')

test.describe('the demo course', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
  })

  test('check yourself: the question shows, the answer waits for an attempt', async ({ page }) => {
    await page.goto(`/courses/${course}/topics/${mathTopic}?view=read`)
    // Scoped to the page body: while a page streams in, Next can keep a hidden copy of the text elsewhere.
    const main = page.locator('#main')
    const reveal = main.getByRole('button', { name: 'Show answer' })
    await expect(reveal).toHaveCount(2)
    await expect(body(page).getByText('A fair die is rolled once.')).toBeVisible()
    await expect(body(page).getByText('Each of the six faces is equally likely')).toHaveCount(0)

    // Attempt first: the button waits until the student has written an answer (or said they don't know).
    const first = reveal.first()
    await expect(first).toBeDisabled()
    await main.getByRole('textbox', { name: 'Your answer' }).first().fill('One in six.')
    await expect(first).toHaveAttribute('aria-expanded', 'false')
    // Keyboard: focus the button and press Enter.
    await first.focus()
    await page.keyboard.press('Enter')
    await expect(body(page).getByText('Each of the six faces is equally likely')).toBeVisible()
    // Math renders in the question and in the answer; the second item is still closed.
    await expect(page.locator('.md-check .katex').first()).toBeVisible()
    await expect(main.getByRole('button', { name: 'Show answer' })).toHaveCount(1)
    await expect(main.getByRole('button', { name: 'Hide answer' })).toHaveCount(0)
  })

  test('a multiple-choice practice step shows its stored options and can be answered by keyboard', async ({ page }) => {
    await page.goto(`/courses/${course}/topics/${mathTopic}?view=practice`)
    await page.getByRole('button', { name: 'Problem 3' }).click()
    await expect(page.getByRole('heading', { level: 2, name: /Reading a probability table/ })).toBeVisible()
    const options = page.getByRole('radio')
    await expect(options).toHaveCount(4)
    await expect(body(page).getByText('They are equally likely')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check' })).toBeDisabled()

    await options.nth(2).focus()
    await page.keyboard.press('Space')
    await page.getByRole('button', { name: 'Check' }).click()
    await expect(body(page).getByText('Not quite')).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    await options.nth(1).focus()
    await page.keyboard.press('Space')
    await page.getByRole('button', { name: 'Check' }).click()
    await expect(body(page).getByText('Correct', { exact: true })).toBeVisible()
    // Leave the saved progress alone for other specs: the browser's cache and the server's rows.
    await expect.poll(() => withPrisma((prisma) => prisma.practiceProgress.count({ where: { topicId: mathTopic } }))).toBeGreaterThan(0)
    await page.evaluate(() => localStorage.clear())
    await withPrisma((prisma) => prisma.practiceProgress.deleteMany({ where: { topicId: mathTopic } }))
  })

})

test.describe('a course built to be edited', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  const stamp = Date.now()
  const email = `structure-ui-${stamp}@example.com`
  let courseId = ''

  const rows = (page: Page, unit: string) => page.getByRole('list', { name: `Topics in ${unit}` }).getByRole('listitem')

  test('set up', async ({ page }) => {
    await signIn(page, email)
    courseId = (await (await page.request.post('/api/projects', { data: { name: `Editor ${stamp}` } })).json()).project.id
    const unit = async (title: string, weekLabel: string) =>
      (await (await page.request.post(`/api/projects/${courseId}/units`, { data: { title, weekLabel } })).json()).unit.id as string
    const a = await unit('Arrays', 'Week 1')
    const b = await unit('Trees', 'Week 2')
    await unit('Spare', 'Week 3')
    const topic = async (name: string, unitId: string) =>
      page.request.post(`/api/projects/${courseId}/topics`, { data: { name, unitId } })
    for (const name of ['Sorting', 'Searching', 'Slicing']) await topic(name, a)
    for (const name of ['Binary trees', 'Heaps']) await topic(name, b)
    await page.request.post(`/api/projects/${courseId}/topics/confirm`)
  })

  test('the editor shows units with their topics; move a topic to another unit with the select', async ({ page }) => {
    await signIn(page, email)
    await page.goto(`/courses/${courseId}/topics?edit=1`)
    await expect(page.getByRole('heading', { level: 1, name: 'Edit topics' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Arrays' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Spare' })).toBeVisible()
    await expect(rows(page, 'Arrays')).toHaveCount(3)
    await expect(rows(page, 'Trees')).toHaveCount(2)
    await expect(body(page).getByText('No topics in this unit yet.')).toBeVisible()
    await expect(body(page).getByText('5 topics in 3 units')).toBeVisible()

    // Move "Slicing" from Arrays to Trees.
    await page.getByRole('button', { name: 'Actions for Slicing' }).click()
    await page.getByRole('menuitem', { name: 'Move to unit...' }).click()
    const dialog = page.getByRole('dialog', { name: 'Move topic' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox', { name: 'Unit' }).click()
    await page.getByRole('option', { name: /Trees/ }).click()
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/topics/'))
    await dialog.getByRole('button', { name: 'Move' }).click()
    await saved
    await expect(rows(page, 'Arrays')).toHaveCount(2)
    await expect(rows(page, 'Trees')).toHaveCount(3)
    // It lands last in the new unit, and the order is kept on the server.
    await page.reload()
    await expect(rows(page, 'Trees').last()).toContainText('Slicing')
    await expect(rows(page, 'Arrays')).toHaveCount(2)
  })

  test('reorder inside a unit with the keyboard; rename a topic', async ({ page }) => {
    await signIn(page, email)
    await page.goto(`/courses/${courseId}/topics?edit=1`)
    const handle = rows(page, 'Arrays').last().getByRole('button', { name: /^Reorder / })
    await handle.focus()
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/topics/'))
    await handle.press('ArrowUp')
    await saved
    await expect(rows(page, 'Arrays').first()).toContainText('Searching')
    await page.reload()
    await expect(rows(page, 'Arrays').first()).toContainText('Searching')

    await rows(page, 'Arrays').first().getByRole('button', { name: 'Rename Searching' }).click()
    await page.getByLabel('Topic name').fill('Binary search')
    await page.getByLabel('Topic name').press('Enter')
    await expect(page.getByRole('button', { name: 'Rename Binary search' })).toBeVisible()
  })

  test('add a unit, rename it, move it, and delete an empty one', async ({ page }) => {
    await signIn(page, email)
    await page.goto(`/courses/${courseId}/topics?edit=1`)

    // Adding a unit is a course action, not a header button.
    await page.getByRole('button', { name: 'Course actions' }).click()
    await page.getByRole('menuitem', { name: 'Add unit' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a unit' })
    await dialog.getByLabel('Title').fill('Graphs')
    await dialog.getByLabel('Week').fill('Week 4')
    await dialog.getByRole('button', { name: 'Add unit' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Graphs' })).toBeVisible()
    await expect(body(page).getByText('Week 4', { exact: true })).toBeVisible()

    // A new topic goes into the unit picked next to the field (the last unit by default).
    await page.getByLabel('Add a topic').locator('visible=true').fill('Shortest paths')
    await page.getByLabel('Add a topic').locator('visible=true').press('Enter')
    await expect(rows(page, 'Graphs')).toHaveCount(1)

    // Rename the unit.
    await page.getByRole('button', { name: 'Actions for unit Graphs' }).click()
    await page.getByRole('menuitem', { name: 'Edit unit' }).click()
    await page.getByRole('dialog', { name: 'Edit unit' }).getByLabel('Title').fill('Graph algorithms')
    await page.getByRole('dialog', { name: 'Edit unit' }).getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Graph algorithms' })).toBeVisible()

    // Move it up; a unit with topics cannot be deleted, an empty one can.
    await page.getByRole('button', { name: 'Actions for unit Graph algorithms' }).click()
    await expect(page.getByRole('menuitem', { name: 'Delete unit' })).toBeDisabled()
    const moved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/units/'))
    await page.getByRole('menuitem', { name: 'Move unit up' }).click()
    await moved
    await page.reload()
    const headings = await page.getByRole('heading', { level: 2 }).allTextContents()
    expect(headings.indexOf('Graph algorithms')).toBeLessThan(headings.indexOf('Spare'))

    await page.getByRole('button', { name: 'Actions for unit Spare' }).click()
    await page.getByRole('menuitem', { name: 'Delete unit' }).click()
    await page.getByRole('button', { name: 'Delete unit' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Spare' })).toHaveCount(0)
  })

  test('a file role is changed from the file menu and kept', async ({ page }) => {
    await signIn(page, email)
    const upload = await page.request.post(`/api/projects/${courseId}/materials?category=lecture_notes&filename=notes.pdf`, {
      data: readFileSync(FIXTURE_PDF),
      headers: { 'content-type': 'application/pdf' },
    })
    expect(upload.ok()).toBeTruthy()
    await page.goto(`/courses/${courseId}/materials`)
    const row = page.getByRole('row', { name: /notes\.pdf/ })
    await expect(row.getByText('Lecture notes', { exact: true }).filter({ visible: true })).toBeVisible()

    await page.getByRole('button', { name: 'Actions for notes.pdf' }).click()
    await page.getByRole('menuitem', { name: 'Use as' }).click()
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/materials/'))
    await page.getByRole('menuitemradio', { name: 'Past exam' }).click()
    expect((await saved).ok()).toBeTruthy()
    await expect(row.getByText('Past exam', { exact: true }).filter({ visible: true })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('row', { name: /notes\.pdf/ }).getByText('Past exam', { exact: true }).filter({ visible: true })).toBeVisible()
    await page.getByRole('button', { name: 'Actions for notes.pdf' }).click()
    await page.getByRole('menuitem', { name: 'Use as' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Past exam' })).toBeChecked()
  })
})
