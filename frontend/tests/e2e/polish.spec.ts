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

test('the lobby and the results give the same score for an attempt', async ({ page }) => {
  const { course } = demoIds()
  await signIn(page, DEMO_EMAIL)
  const [examId, submissionId] = (await gradedAttempts(page, course))[0]
  await page.goto(`/courses/${course}/exams/${examId}/results/${submissionId}`)
  const resultScore = (await page.getByRole('img', { name: /^Score / }).getAttribute('aria-label'))!.replace('Score ', '')
  await page.goto(`/courses/${course}/exams/${examId}`)
  await expect(page.getByRole('list').getByText(resultScore, { exact: true }).first()).toBeVisible()
})
