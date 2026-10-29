import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'

// The accessibility and polish fixes: real 404s, the theme control, the review of a graded exam
// (what a written answer was graded against, "Explain this mistake", one score everywhere).
// Runs on the demo account and its graded mock exam, which global-setup.ts seeds.

/** Every graded attempt of the demo course's exams: [exam id, submission id]. Other specs add exams too. */
async function gradedAttempts(page: Page, course: string): Promise<[string, string][]> {
  const found: [string, string][] = []
  const { exams } = await (await page.request.get(`/api/projects/${course}/exams`)).json()
  for (const exam of exams as { id: string }[]) {
    const { submissions } = await (await page.request.get(`/api/exams/${exam.id}/submissions`)).json()
    for (const item of submissions as { id: string; score: number | null }[]) {
      if (item.score !== null) found.push([exam.id, item.id])
    }
  }
  if (found.length === 0) throw new Error('the demo account has no graded exam')
  return found
}

/** Opens the results of an attempt that has a written answer in it (the seeded exam does; one that was submitted blank may not). */
async function openAttemptWithWrittenAnswer(page: Page, course: string): Promise<[string, string]> {
  for (const [examId, submissionId] of await gradedAttempts(page, course)) {
    await page.goto(`/courses/${course}/exams/${examId}/results/${submissionId}`)
    await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
    if ((await page.getByRole('button', { name: 'Disagree? Grade again' }).count()) > 0) return [examId, submissionId]
  }
  throw new Error('no graded attempt has a written answer')
}

test('an address that names nothing answers 404, in the app and in the exam shell', async ({ page }) => {
  const { course } = demoIds()
  await signIn(page, DEMO_EMAIL)
  for (const path of [
    '/courses/not-a-uuid',
    `/courses/${course}/exams/not-a-uuid`,
    `/courses/${course}/exams/not-a-uuid/take`,
    `/courses/${course}/topics/not-a-uuid`,
    // A NUL byte is not valid database input: it must be "not found", not a server error.
    '/courses/%00',
    `/courses/${course}/exams/%00`,
  ]) {
    const response = await page.goto(path)
    expect(response?.status(), path).toBe(404)
    await expect(page.getByRole('heading', { level: 1, name: "We couldn't find that page" }), path).toBeVisible()
  }
  // Inside a course the way back leads to the course.
  await page.goto(`/courses/${course}/exams/not-a-uuid`)
  await expect(page.getByRole('link', { name: 'Back to the course' })).toHaveAttribute('href', `/courses/${course}`)
})

test('the theme is a visible choice in the account menu', async ({ page }) => {
  await signIn(page, DEMO_EMAIL)
  await page.getByRole('button', { name: /account menu/i }).click()
  // Not behind a submenu: the three choices are in the menu itself.
  for (const name of ['Light', 'Dark', 'System']) {
    await expect(page.getByRole('menuitemradio', { name })).toBeVisible()
  }
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked()
  await page.getByRole('menuitemradio', { name: 'Light' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
})

test('a graded exam shows what was checked, and asks Ask to explain a miss', async ({ page }) => {
  const { course } = demoIds()
  await signIn(page, DEMO_EMAIL)
  await openAttemptWithWrittenAnswer(page, course)

  // A written answer: the rubric, the model answer and a way to ask for another grading.
  const rubric = page.getByRole('group', { name: /was graded/ }).first()
  await expect(rubric).toBeVisible()
  await expect(rubric.getByText(/for the whole answer/)).toBeVisible()
  await expect(page.getByText('Model answer').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disagree? Grade again' }).first()).toBeVisible()

  // The score reads the same in the ring, the lobby and everywhere else (one decimal at most).
  const ring = await page.getByRole('img', { name: /^Score / }).getAttribute('aria-label')
  await expect(page.getByRole('img', { name: /^Score / })).toContainText(ring!.replace('Score ', ''))

  // A missed question opens Ask with the question and the answer written, and nothing sent.
  await page.getByRole('link', { name: 'Explain this mistake' }).first().click()
  await expect(page).toHaveURL(/\/ask\?.*q=/)
  const box = page.locator('#ask-composer')
  await expect(box).toHaveValue(/Explain this mistake\.[\s\S]*Question: [\s\S]*My answer: /)
})

test('the lobby and the results give the same score for an attempt', async ({ page }) => {
  const { course } = demoIds()
  await signIn(page, DEMO_EMAIL)
  const [examId, submissionId] = (await gradedAttempts(page, course))[0]
  await page.goto(`/courses/${course}/exams/${examId}/results/${submissionId}`)
  const resultScore = (await page.getByRole('img', { name: /^Score / }).getAttribute('aria-label'))!.replace('Score ', '')
  await page.goto(`/courses/${course}/exams/${examId}`)
  await expect(page.getByRole('list').getByText(resultScore, { exact: true }).first()).toBeVisible()
})
