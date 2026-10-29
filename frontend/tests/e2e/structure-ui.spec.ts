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
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })

test.describe('the demo course', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
  })

  test('the topics page groups topics by unit, with the rest under "Topics"', async ({ page }) => {
    await page.goto(`/courses/${course}/topics`)
    await expect(page.getByRole('heading', { level: 1, name: 'Topics' })).toBeVisible()

    const first = page.getByRole('region', { name: 'Sorting and graphs' })
    await expect(first.getByRole('heading', { level: 2, name: 'Sorting and graphs' })).toBeVisible()
    await expect(first.getByText('Week 1', { exact: true })).toBeVisible()
    await expect(first.getByText('2 topics')).toBeVisible()
    await expect(first.getByText(/Not started|Learning|Getting there|Strong/).first()).toBeVisible()
    await expect(first.getByRole('list', { name: 'Topics in Sorting and graphs' }).getByRole('listitem')).toHaveCount(2)

    const second = page.getByRole('region', { name: 'Dynamic programming and hashing' })
    await expect(second.getByText('Week 2', { exact: true })).toBeVisible()
    await expect(second.getByRole('listitem')).toHaveCount(2)

    // The topic that belongs to no unit sits in a plain "Topics" group.
    const loose = page.getByRole('region', { name: 'Topics', exact: true })
    await expect(loose.getByRole('link', { name: /Discrete random variables/ })).toBeVisible()

    // "Needs work" is one list across units.
    await page.getByRole('radio', { name: 'Needs work' }).click()
    await expect(page.getByRole('region', { name: 'Sorting and graphs' })).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Topics', exact: true }).getByRole('listitem')).toHaveCount(5)
  })

  test('the sidebar groups topics by unit, and each unit opens and closes (remembered per course)', async ({ page }) => {
    await page.goto(`/courses/${course}/topics/${topics[0]}?view=notes`)
    const nav = sidebar(page)
    const unit = nav.getByRole('button', { name: /Sorting and graphs/ })
    const topicLink = nav.getByRole('link', { name: 'Graph traversal' })

    // The unit with the current topic is open.
    await expect(unit).toHaveAttribute('aria-expanded', 'true')
    await expect(topicLink).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Sorting algorithms' })).toHaveAttribute('aria-current', 'page')

    await unit.click()
    await expect(unit).toHaveAttribute('aria-expanded', 'false')
    await expect(topicLink).toBeHidden()

    // Still closed after a reload: the choice is kept for this course.
    await page.goto(`/courses/${course}/topics`)
    await expect(nav.getByRole('button', { name: /Sorting and graphs/ })).toHaveAttribute('aria-expanded', 'false')
    expect(await page.evaluate((id) => localStorage.getItem(`margins:sidebar-units:${id}`), course)).toContain('false')

    // The unit that holds a topic opens by itself when that topic is opened.
    await page.goto(`/courses/${course}/topics/${topics[1]}?view=notes`)
    await expect(nav.getByRole('button', { name: /Sorting and graphs/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(nav.getByRole('link', { name: 'Graph traversal' })).toHaveAttribute('aria-current', 'page')

    // Keyboard: the unit button is a real button.
    const dynamic = nav.getByRole('button', { name: /Dynamic programming and hashing/ })
    await dynamic.focus()
    await page.keyboard.press('Enter')
    await expect(dynamic).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Space')
    await expect(dynamic).toHaveAttribute('aria-expanded', 'false')
  })

  test('the topic header shows objectives, prerequisites, sources and time', async ({ page }) => {
    await page.goto(`/courses/${course}/topics/${topics[1]}?view=notes`)
    const about = page.getByRole('region', { name: 'About this topic' })
    await expect(about.getByRole('heading', { level: 2, name: 'By the end you can' })).toBeVisible()
    await expect(about.getByRole('listitem').filter({ hasText: 'run breadth-first and depth-first search by hand' })).toBeVisible()
    await expect(body(page).getByText('About 30 min')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Week 1: Sorting and graphs' })).toBeVisible()

    // Prerequisites link to the topic.
    await about.getByRole('link', { name: 'Sorting algorithms' }).click()
    await expect(page).toHaveURL(new RegExp(`/topics/${topics[0]}`))

    // Sources link to the file viewer at the page; math in an objective is typeset.
    const source = page.getByRole('region', { name: 'About this topic' }).getByRole('link', { name: 'algorithms.pdf, pp. 1-2' })
    await expect(source).toHaveAttribute('href', /\/api\/materials\/[0-9a-f-]{36}\/file#page=1$/)
    await expect(source).toHaveAttribute('target', '_blank')
    await expect(page.getByRole('region', { name: 'About this topic' }).locator('.katex').first()).toBeVisible()
  })

  test('a topic added by hand has no objectives block', async ({ page }) => {
    await page.goto(`/courses/${course}/topics/${mathTopic}?view=notes`)
    await expect(page.getByRole('heading', { level: 1, name: 'Discrete random variables' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'About this topic' })).toHaveCount(0)
  })

  test('check yourself: the question shows, the answer waits behind a button', async ({ page }) => {
    await page.goto(`/courses/${course}/topics/${mathTopic}?view=notes`)
    // Scoped to the page body: while a page streams in, Next can keep a hidden copy of the text elsewhere.
    const main = page.locator('#main')
    const reveal = main.getByRole('button', { name: 'Show answer' })
    await expect(reveal).toHaveCount(2)
    await expect(body(page).getByText('A fair die is rolled once.')).toBeVisible()
    await expect(body(page).getByText('Each of the six faces is equally likely')).toHaveCount(0)

    const first = reveal.first()
    await expect(first).toHaveAttribute('aria-expanded', 'false')
    // Keyboard: focus the button and press Enter.
    await first.focus()
    await page.keyboard.press('Enter')
    const hide = main.getByRole('button', { name: 'Hide answer' })
    await expect(hide).toHaveAttribute('aria-expanded', 'true')
    await expect(body(page).getByText('Each of the six faces is equally likely')).toBeVisible()
    // Math renders in the question and in the answer; the second item is still closed.
    await expect(page.locator('.md-check .katex').first()).toBeVisible()
    await expect(main.getByRole('button', { name: 'Show answer' })).toHaveCount(1)

    await hide.click()
    await expect(body(page).getByText('Each of the six faces is equally likely')).toHaveCount(0)
  })

  test('notes without check blocks are unchanged', async ({ page }) => {
    // The mock notes of the first topic have one block; make sure the rest of the page still reads as before.
    await page.goto(`/courses/${course}/topics/${topics[2]}?view=notes`)
    await expect(page.getByRole('heading', { level: 2, name: 'Key concepts' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mark as read' })).toBeVisible()
  })

  test('sources sit under worked examples and practice problems', async ({ page }) => {
    await page.goto(`/courses/${course}/topics/${mathTopic}?view=examples`)
    const link = page.getByRole('link', { name: 'algorithms.pdf, pp. 1-2' })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /\/api\/materials\/[0-9a-f-]{36}\/file#page=1$/)
    await expect(body(page).getByText(/^From\s+algorithms\.pdf, pp\. 1-2/)).toBeVisible()
    // The second example is closed until it is opened; its file has no id, so the source is plain text.
    await page.getByRole('button', { name: /^2\s/ }).click()
    await expect(body(page).getByText('From lecture-notes.pdf, p. 7')).toBeVisible()

    await page.goto(`/courses/${course}/topics/${mathTopic}?view=practice`)
    await expect(page.getByRole('link', { name: 'algorithms.pdf, pp. 3-4' })).toBeVisible()

    // Content written by the mock service carries sources too.
    await page.goto(`/courses/${course}/topics/${topics[0]}?view=examples`)
    await expect(page.getByRole('link', { name: /^algorithms\.pdf, p\. \d/ })).toBeVisible()
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

  test('materials show a role badge on each file', async ({ page }) => {
    await page.goto(`/courses/${course}/materials`)
    await expect(page.getByRole('columnheader', { name: 'Used as' })).toBeVisible()
    // One label per file: the role. The upload category is not a column of its own.
    await expect(page.getByRole('columnheader', { name: 'Type' })).toHaveCount(0)
    await expect(page.getByRole('row', { name: /algorithms\.pdf/ }).getByText('Content', { exact: true }).filter({ visible: true })).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Use these as:' }).getByRole('radio', { name: 'Syllabus or schedule' })).toBeVisible()
    await expect(page.getByText("PDFs need selectable text. Scans can't be read.", { exact: false })).toBeVisible()
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

    await page.getByRole('button', { name: 'Add unit' }).click()
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

  test('the topics page shows the units that were made', async ({ page }) => {
    await signIn(page, email)
    await page.goto(`/courses/${courseId}/topics`)
    await expect(page.getByRole('region', { name: 'Trees' }).getByText('3 topics')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Graph algorithms' }).getByText('1 topic', { exact: true })).toBeVisible()
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
    await expect(row.getByText('Content', { exact: true }).filter({ visible: true })).toBeVisible()

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
