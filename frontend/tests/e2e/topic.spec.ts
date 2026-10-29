import { existsSync, readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { withPrisma } from './helpers/db'
import { FIXTURE_PDF } from './helpers/seed-demo'

// One account per run. The AI service behind the dev stack is a mock, so generating content is
// free and fast; the spec writes every kind of content through the page itself.
const stamp = Date.now()
const email = `topic-${stamp}@example.com`
// Content is written from uploaded files, so the course needs one. Set E2E_PDF to use another.
const pdfPath = process.env.E2E_PDF ?? FIXTURE_PDF
const TOPICS = ['Graph traversal', 'Sorting algorithms', 'Dynamic programming']

const CONTENT_TYPES = ['section_notes', 'solved_examples', 'interactive_examples', 'topic_quiz']

/** The content types a topic has written so far. */
async function writtenTypes(page: Page, topicId: string): Promise<string[]> {
  const response = await page.request.get(`/api/topics/${topicId}/content`)
  const body = await response.json()
  return (body.content ?? []).map((row: { contentType: string }) => row.contentType).sort()
}

/** How many notes jobs were ever created for the topic (any outcome), read from the stack's database. */
async function notesJobCount(topicId: string): Promise<number> {
  return withPrisma((prisma) => prisma.processingJob.count({ where: { targetKey: `content:${topicId}:section_notes` } }))
}

async function createCourse(page: Page) {
  const course = await page.request.post('/api/projects', { data: { name: `Topic course ${stamp}` } })
  expect(course.ok()).toBeTruthy()
  const courseId = (await course.json()).project.id as string
  const upload = await page.request.post(
    `/api/projects/${courseId}/materials?category=lecture_notes&filename=algorithms.pdf`,
    { data: readFileSync(pdfPath), headers: { 'content-type': 'application/pdf' } }
  )
  expect(upload.ok()).toBeTruthy()
  await expect
    .poll(
      async () => {
        const body = await (await page.request.get(`/api/projects/${courseId}/materials`)).json()
        return body.materials.map((item: { validationStatus: string }) => item.validationStatus).join()
      },
      { timeout: 120_000 }
    )
    .toBe('valid')
  // Topic finding starts by itself once the file is chunked and ends by marking the course
  // "topics pending". Let it finish first, or it would undo the confirmation below.
  await expect
    .poll(async () => (await (await page.request.get(`/api/projects/${courseId}/topics`)).json()).topics.length, {
      timeout: 120_000,
    })
    .toBeGreaterThan(0)
  const ids: string[] = []
  for (const name of TOPICS) {
    const topic = await page.request.post(`/api/projects/${courseId}/topics`, {
      data: { name, description: `About ${name}.` },
    })
    expect(topic.ok()).toBeTruthy()
    ids.push((await topic.json()).topic.id as string)
  }
  await page.request.post(`/api/projects/${courseId}/topics/confirm`)
  return { courseId, ids }
}

test.describe.configure({ mode: 'serial' })

let course: { courseId: string; ids: string[] } | null = null

test('the study path: write, read, practise, take a quiz', async ({ page }) => {
  test.skip(!existsSync(pdfPath), `needs ${pdfPath}`)
  test.setTimeout(300_000)

  await signIn(page, email)

  const { courseId, ids } = (course = await createCourse(page))
  const base = `/courses/${courseId}/topics/${ids[0]}`

  // No view in the address: it goes to the first unfinished one.
  await page.goto(base)
  await expect(page).toHaveURL(/\?view=notes$/)
  await expect(page.getByRole('heading', { level: 1, name: TOPICS[0] })).toBeVisible()
  // "Ask about this" opens the Ask sheet scoped to the topic, with a link to the full page.
  await page.getByRole('button', { name: 'Ask about this' }).click()
  const sheet = page.getByRole('dialog', { name: 'Ask about this topic' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('link', { name: 'Open full page' })).toHaveAttribute(
    'href',
    new RegExp(`/courses/${courseId}/ask\\?topic=${ids[0]}`)
  )
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // The notes are written without a click; the view fills in when the job finishes.
  await expect(page.getByRole('heading', { name: 'Overview' }).first()).toBeVisible({ timeout: 90_000 })
  // The page can ask more than once (it renders again after the redirect to ?view=notes), but
  // only one notes job is ever created: nothing is written twice.
  expect(await notesJobCount(ids[0])).toBe(1)
  await expect(page.getByRole('button', { name: 'Write notes' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Study path' }).getByRole('link', { name: /Notes/ })).toHaveAttribute('aria-current', 'page')

  // Mark as read, then the next view is offered.
  await page.getByRole('button', { name: 'Mark as read' }).click()
  await expect(page.getByText("You've read these notes.")).toBeVisible()
  await expect(page.getByRole('link', { name: /Next: Worked examples/ })).toBeVisible()

  // The AI service then writes the other three types, one after another, with no clicks.
  await expect.poll(() => writtenTypes(page, ids[0]), { timeout: 120_000 }).toEqual([...CONTENT_TYPES].sort())

  // Number keys switch views; typing in a field does not.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('2')
  await expect(page).toHaveURL(/view=examples/)
  await page.keyboard.press('3')
  await expect(page).toHaveURL(/view=practice/)

  // Practice was written by the chain: answer wrong, try again, answer right. Progress survives a reload.
  await expect(page.getByLabel('Your answer')).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Your answer').fill('5')
  await page.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(page.getByText('Not quite')).toBeVisible()
  await page.getByRole('button', { name: 'Try again' }).click()
  await page.getByLabel('Your answer').fill('4')
  await page.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(page.getByText('Correct', { exact: true })).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('navigation', { name: 'Study path' }).getByRole('link', { name: /Practice/ }).getByRole('img', { name: 'Completed' })
  ).toBeVisible()

  // Examples: mark as done. That also starts the next topic's notes in the background.
  await page.goto(`${base}?view=examples`)
  await expect(page.getByRole('button', { name: /Worked example/ })).toBeVisible({ timeout: 30_000 })
  // The next topic is the one the header offers (topic finding may have added topics of its own).
  const nextName = ((await page.getByRole('button', { name: /^Next: / }).getAttribute('aria-label')) ?? '').replace(/^Next: /, '')
  const list = await (await page.request.get(`/api/projects/${courseId}/topics`)).json()
  const nextTopic = list.topics.find((topic: { name: string }) => topic.name === nextName)
  expect(nextTopic).toBeTruthy()
  expect(await notesJobCount(nextTopic.id)).toBe(0)
  await page.getByRole('button', { name: 'Mark as done' }).click()
  await expect(page.getByText("You've worked through these examples.")).toBeVisible()
  // (A topic found by extraction has no mapped text in this stack, so the job may fail; it was started.)
  await expect.poll(() => notesJobCount(nextTopic.id), { timeout: 60_000 }).toBe(1)

  // Quiz: written by the chain too. Answer with the keyboard, leave one blank, submit.
  await page.goto(`${base}?view=quiz`)
  await expect(page.getByRole('button', { name: 'Start quiz' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Start quiz' }).click()
  await expect(page.getByText('Question 1 of')).toBeVisible()
  await page.keyboard.press('b')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByText('Question 2 of')).toBeVisible()
  // A reload keeps the answers.
  await page.reload()
  await expect(page.getByText('Question 2 of')).toBeVisible()
  await page.getByRole('button', { name: 'Question 1, answered' }).click()
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(1)

  const total = Number((await page.getByText(/Question \d+ of \d+/).textContent())?.match(/of (\d+)/)?.[1])
  for (let index = 1; index < total; index += 1) await page.getByRole('button', { name: `Question ${index + 1}`, exact: false }).first().click()
  await page.getByRole('button', { name: 'Submit quiz' }).click()
  await expect(page.getByRole('dialog')).toContainText('unanswered')
  await page.getByRole('dialog').getByRole('button', { name: 'Submit quiz' }).click()

  await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Retake' })).toBeVisible()
  await page.getByRole('radio', { name: /Missed/ }).click()
  await page.getByRole('button', { name: /4, Fairly sure/ }).click()
  await expect(page.getByRole('button', { name: /4, Fairly sure/ })).toHaveAttribute('aria-pressed', 'true')

  // The attempt is in the lobby's history, with a review.
  await page.getByRole('button', { name: 'Back to quiz' }).click()
  await expect(page.getByRole('heading', { name: 'Past attempts' })).toBeVisible()
  await page.getByRole('button', { name: 'Review' }).first().click()
  await expect(page.getByText('Your answer').first()).toBeVisible()

  // ] goes to the next topic and keeps the view. (Extraction may have added topics of its own,
  // so only the change is checked, not which topic it is.)
  const before = page.url()
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press(']')
  await expect(page).not.toHaveURL(before)
  await expect(page).toHaveURL(/view=quiz$/)
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(TOPICS[0])
})

test('Prepare all topics now writes the rest of the course, one topic at a time', async ({ page }) => {
  test.skip(!course, 'needs the course from the study path test')
  test.setTimeout(300_000)
  const { courseId, ids } = course!

  await signIn(page, email)

  // The overview has no bulk "build" action any more; it is a course menu item with an estimate.
  await page.goto(`/courses/${courseId}`)
  await expect(page.getByRole('button', { name: /Build the missing study content|Build missing content|Generate/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'More course actions' }).click()
  await page.getByRole('menuitem', { name: 'Prepare all topics now' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(/about \d+ topics/)
  await expect(dialog).toContainText("large part of today's AI allowance")
  await expect(dialog).not.toContainText('$')
  // Cancelling starts nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(await writtenTypes(page, ids[ids.length - 1])).not.toContain('topic_quiz')

  await page.getByRole('button', { name: 'More course actions' }).click()
  await page.getByRole('menuitem', { name: 'Prepare all topics now' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Prepare all topics' }).click()

  // Every topic ends up with all four types, written by the server's chain. (Topics found by
  // extraction have no mapped text in this stack: their notes fail and the run skips them.)
  for (const id of ids) {
    await expect.poll(() => writtenTypes(page, id), { timeout: 240_000 }).toEqual([...CONTENT_TYPES].sort())
  }
})
