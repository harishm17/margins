import { expect, test, type Page } from '@playwright/test'
import { createCourse, dayIn, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// What a brand-new student meets. A signed-in student never sees the landing page, so the app explains
// itself: a welcome Home, a setup page that asks for the exam date and says what a topic holds, a first
// greeting that does not say "back", and a course menu that does not lead to empty pages during setup.

test.use({ timezoneId: ZONE })
test.setTimeout(120_000)

const courseNav = (page: Page) => page.getByRole('navigation', { name: 'Course', exact: true })

test('setup ends in one form: the date is optional, the time is kept, and one button starts the first topic', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'first-run-exam', { own: true })
  const { courseId } = await createCourse(page, 'Exam date course', [{ name: 'Bayes rule' }, { name: 'Priors' }])
  await page.goto(`/courses/${courseId}`)

  // Step 3 is one form: the exam date (optional), the daily time and the way into the first topic.
  await expect(page.getByRole('heading', { level: 2, name: 'Start studying' })).toBeVisible()
  const form = page.getByRole('form', { name: 'Exam date and daily time' })
  await expect(form).toBeVisible()
  await expect(form.getByLabel('Exam date')).toBeVisible()
  await expect(form.getByRole('button', { name: 'Save and start warm-up' })).toBeVisible()
  await expect(form.getByRole('button', { name: 'Start without a date' })).toBeVisible()
  await expect(form.getByRole('button', { name: 'Skip for now' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Start warm-up: Bayes rule' })).toHaveCount(0)

  // The course is ready, so nothing in the menu is held back any more.
  await expect(courseNav(page).getByRole('link', { name: 'Plan', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('setup-progress')).toHaveCount(0)

  // A changed time with no date saves without an error and opens the first topic.
  await form.getByRole('combobox', { name: 'Typical daily study time' }).click()
  await page.getByRole('option', { name: '20 minutes' }).click()
  await form.getByRole('button', { name: 'Save and start warm-up' }).click()
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/topics/`))
  const saved = (await (await page.request.get(`/api/projects/${courseId}`)).json()).project
  expect(saved.dailyMinutes).toBe(20)
  expect(saved.examDate).toBeNull()
  expect(saved.examPromptDismissed).toBe(true)

  // Back on the setup page the question is closed: one link remains.
  await page.goto(`/courses/${courseId}`)
  await expect(page.getByRole('form', { name: 'Exam date and daily time' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Start warm-up: Bayes rule' })).toBeVisible()
})

test('the exam date entered in the setup form is saved with the time', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'first-run-dated', { own: true })
  const { courseId } = await createCourse(page, 'Dated setup course', [{ name: 'Graphs' }])
  await page.goto(`/courses/${courseId}`)
  const form = page.getByRole('form', { name: 'Exam date and daily time' })
  await form.getByLabel('Exam date').fill(dayIn(ZONE, 30))
  await form.getByRole('button', { name: 'Save and start warm-up' }).click()
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/topics/`))
  const saved = (await (await page.request.get(`/api/projects/${courseId}`)).json()).project
  expect(JSON.stringify(saved)).toContain(dayIn(ZONE, 30))
})

