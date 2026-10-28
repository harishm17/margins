import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { DEMO_EMAIL, FIXTURE_DOCX, FIXTURE_PDF } from './helpers/seed-demo'

// Course setup end to end: materials, topic editor, content build, topics list, then Home and
// the Today view. One account per run so it can run again against the same database.
// Test files: tests/e2e/fixtures/algorithms.pdf and hashing.docx.
const stamp = Date.now()
const email = `course-${stamp}@example.com`
const courseName = `Course spec ${stamp}`
const PDF = FIXTURE_PDF
const DOCX = FIXTURE_DOCX

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let courseUrl = ''

async function signUpAndCreateCourse(page: Page) {
  // The first sign-in makes the account.
  await signIn(page, email)
  await page.goto('/courses/new')
  await page.getByLabel('Course name').fill(courseName)
  await page.getByRole('button', { name: 'Create course' }).click()
  await expect(page).toHaveURL(/\/courses\/[0-9a-f-]{36}$/)
  courseUrl = page.url()
}

test('setup guide: upload materials and wait for topics', async ({ page }) => {
  await signUpAndCreateCourse(page)

  await expect(page.getByRole('heading', { level: 1, name: courseName })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Add your materials' })).toBeVisible()
  await expect(page.getByText('Drop files here or')).toBeVisible()

  // A file that is not allowed is refused in the browser, with a reason.
  await page.getByLabel('Choose files to upload').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a study file'),
  })
  await expect(page.getByText('Use a PDF, DOCX, PPTX or DOC file.')).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss notes.txt' }).click()
  await expect(page.getByText('notes.txt')).toHaveCount(0)

  // Real files go through the pipeline. The page refreshes itself, with no reload.
  await page.getByLabel('Choose files to upload').setInputFiles([PDF, DOCX])
  await expect(page.getByText('algorithms.pdf')).toBeVisible()
  await expect(page.getByText('hashing.docx')).toBeVisible()

  // Files read: each shows its phase while it is read, step 1 keeps its list and says so when every file is
  // done. Topic finding starts by itself; if two files finish at the same moment it can miss, and the guide
  // offers a button for that.
  await expect(page.getByText('Every file here has been read.')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(2)
  const review = page.getByRole('link', { name: 'Review topics' })
  const find = page.getByRole('button', { name: 'Find topics' })
  await expect(review.or(find)).toBeVisible({ timeout: 30_000 })
  if (await find.isVisible()) await find.click()
  await expect(review).toBeVisible({ timeout: 90_000 })
})

test('topic editor: rename, add, reorder, merge, delete, confirm', async ({ page }) => {
  await signIn(page, email)

  await page.goto(`${courseUrl}/topics`)
  await expect(page.getByRole('heading', { level: 1, name: 'Check the topics' })).toBeVisible()
  // With units there is one list per unit ("Topics in <unit>"); the rows are every topic in all of them.
  const rows = page.getByRole('list', { name: /^Topics/ }).getByRole('listitem')
  const initial = await rows.count()
  expect(initial).toBeGreaterThanOrEqual(2)

  // Rename inline: Enter saves.
  await rows.first().getByRole('button', { name: /^Rename / }).click()
  const nameInput = page.getByLabel('Topic name').locator('visible=true')
  await nameInput.fill('Renamed first topic')
  await nameInput.press('Enter')
  await expect(rows.first().getByRole('button', { name: 'Rename Renamed first topic' })).toBeVisible()

  // Escape cancels.
  await rows.first().getByRole('button', { name: 'Rename Renamed first topic' }).click()
  await page.getByLabel('Topic name').locator('visible=true').fill('Should not stay')
  await page.getByLabel('Topic name').locator('visible=true').press('Escape')
  await expect(rows.first().getByRole('button', { name: 'Rename Renamed first topic' })).toBeVisible()

  // Add a topic.
  await page.getByLabel('Add a topic').locator('visible=true').fill('Added by hand')
  await page.getByLabel('Add a topic').locator('visible=true').press('Enter')
  await expect(rows).toHaveCount(initial + 1)
  await expect(page.getByRole('button', { name: 'Rename Added by hand' })).toBeVisible()

  // Keyboard reorder: focus the handle of the last row and press ArrowUp.
  const lastHandle = rows.last().getByRole('button', { name: /^Reorder / })
  await lastHandle.focus()
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/api/topics/')
  )
  await lastHandle.press('ArrowUp')
  await saved
  await expect(rows.nth(initial - 1).getByRole('button', { name: 'Rename Added by hand' })).toBeVisible()
  // The order is kept on the server.
  await page.reload()
  await expect(rows.nth(initial - 1).getByRole('button', { name: 'Rename Added by hand' })).toBeVisible()

  // Merge the added topic into the first one.
  await rows.nth(initial - 1).getByRole('button', { name: 'Actions for Added by hand' }).click()
  await page.getByRole('menuitem', { name: 'Merge into...' }).click()
  await page.getByRole('menuitem', { name: 'Renamed first topic' }).click()
  await expect(page.getByRole('dialog')).toContainText('Merge Added by hand into Renamed first topic?')
  await expect(page.getByRole('dialog')).toContainText('Content and quiz history move to Renamed first topic.')
  await page.getByRole('button', { name: 'Merge topics' }).click()
  await expect(rows).toHaveCount(initial)

  // Delete asks first; cancelling keeps the topic.
  await rows.last().getByRole('button', { name: /^Actions for / }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('dialog')).toContainText('Delete')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(rows).toHaveCount(initial)

  // Confirm: back to the overview, where step 3 is next: start the first topic (its notes are
  // written when it is opened, so there is no bulk "build" button).
  await page.getByRole('button', { name: 'Confirm topics' }).click()
  await expect(page).toHaveURL(courseUrl)
  await expect(page.getByRole('heading', { level: 2, name: 'Start studying' })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Start / })).toBeVisible()
  await expect(page.getByRole('button', { name: /Build study content|Build missing content/ })).toHaveCount(0)
  await expect(page.getByText(`${initial} topics confirmed.`)).toBeVisible()
})

test('starting the first topic writes its notes, then topics list and materials', async ({ page }) => {
  await signIn(page, email)

  // Opening a topic with no notes starts them. The dev AI service may have no chunked text for
  // these files, so the job can fail with a reason and a way to try again (it is not started a
  // second time by itself). With text mapped, the notes appear.
  await page.goto(courseUrl)
  await page.getByRole('link', { name: /^Start / }).click()
  await expect(page).toHaveURL(/\/topics\/[0-9a-f-]{36}\?view=notes$/)
  await expect(
    page.getByText(/couldn't be written/).or(page.getByRole('heading', { name: 'Overview' }).first()).first()
  ).toBeVisible({ timeout: 60_000 })

  // The topics list: confirmed topics, and no bulk build button.
  await page.goto(`${courseUrl}/topics`)
  await expect(page.getByRole('heading', { level: 1, name: 'Topics' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Edit topics' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Build missing content/ })).toHaveCount(0)
  await page.getByRole('radio', { name: 'Needs work' }).click()
  await expect(page.getByRole('list', { name: /^Topics/ }).getByRole('listitem').first()).toBeVisible()

  // Materials: open the row menu and delete one file with a confirmation.
  await page.goto(`${courseUrl}/materials`)
  await expect(page.getByRole('heading', { level: 1, name: 'Materials' })).toBeVisible()
  await expect(page.getByText('Ready').first()).toBeVisible()
  await page.getByRole('button', { name: 'Actions for hashing.docx' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('dialog')).toContainText('Delete hashing.docx?')
  await expect(page.getByRole('dialog')).toContainText('Topics built from it keep their content.')
  await page.getByRole('button', { name: 'Delete file' }).click()
  await expect(page.getByText('hashing.docx')).toHaveCount(0)
})

test('Home has no dashed new course tile and never says 0 strong; the demo course shows Today', async ({ page }) => {
  await signIn(page, DEMO_EMAIL)
  await page.goto('/home')

  // The header button stays; the tile is gone.
  await expect(page.getByRole('link', { name: 'New course' })).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 2, name: 'Courses' })).toBeVisible()
  expect(await page.getByRole('heading', { level: 3 }).count()).toBeGreaterThan(0)
  await expect(page.getByText('0 strong')).toHaveCount(0)

  // The Today view of an active course.
  await page.getByRole('link', { name: /CS 161 Algorithms/ }).first().click()
  await expect(page.getByRole('region', { name: 'Up next' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Course mastery' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('heading', { level: 2, name: 'Topics' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Recent mock exams' })).toBeVisible()
})
