import { expect, test, type Page } from '@playwright/test'
import { addFileRow, createCourse, createEmptyCourse, dayIn, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// What a brand-new student meets. A signed-in student never sees the landing page, so the app explains
// itself: a welcome Home, a setup page that asks for the exam date and says what a topic holds, a first
// greeting that does not say "back", and a course menu that does not lead to empty pages during setup.

test.use({ timezoneId: ZONE })
test.setTimeout(120_000)

const WAITING = ['Plan', 'Topics', 'Ask', 'Mock exams', 'Review', 'Map']

const courseNav = (page: Page) => page.getByRole('navigation', { name: 'Course', exact: true })

test('a new account lands on a welcome page that explains the stages and has one way in', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'first-run-welcome', { own: true })

  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Margins' })).toBeVisible()
  const stages = page.getByRole('region', { name: 'Set up your first course' })
  // The same three steps as the course's own setup page (features/course/course-stages.ts).
  await expect(stages.getByRole('listitem')).toHaveCount(3)
  await expect(stages.getByRole('heading', { level: 3 })).toHaveText([/^Add your materials/, /^Check the topics/, /^Start studying/])
  await expect(stages).toContainText('A couple of minutes')
  await expect(stages).toContainText('About a minute')
  // The five steps of a topic are said on the course's setup page, not in this overview.
  await expect(stages).not.toContainText('Warm-up')
  await expect(stages).toContainText('Set your exam date and daily time')
  await expect(page.getByText('Welcome back')).toHaveCount(0)

  await page.getByRole('link', { name: 'Add your first course' }).click()
  await expect(page).toHaveURL(/\/courses\/new$/)
})

test('while a course is in setup, the navigation is the setup one: no dead study pages, a progress block instead', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'first-run-gated', { own: true })
  const courseId = await createEmptyCourse(page, 'Gated course')
  await page.goto(`/courses/${courseId}`)

  const nav = courseNav(page)
  // The pages with nothing in them yet are not listed as dead links at all.
  for (const label of WAITING) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0)
  }
  // Overview and Materials are real links, and a compact progress block says where the student is and what opens next.
  await expect(nav.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-disabled', 'true')
  await expect(nav.getByRole('link', { name: 'Materials' })).toHaveAttribute('href', `/courses/${courseId}/materials`)
  const progress = page.getByTestId('setup-progress')
  await expect(progress).toContainText('Step 1 of 3')
  await expect(progress).toContainText('open once you confirm your topics.')

  // The phone's tab bar is the setup one: the steps, the files, the settings and the way back to the courses.
  await page.setViewportSize({ width: 390, height: 800 })
  const tabs = page.getByRole('navigation', { name: 'Course tabs' })
  for (const label of ['Setup', 'Materials', 'Settings', 'Courses']) {
    await expect(tabs.getByRole('link', { name: label, exact: true })).toBeVisible()
  }
  for (const label of ['Plan', 'Topics', 'Ask', 'More']) {
    await expect(tabs.getByRole('link', { name: new RegExp(`^${label}`) })).toHaveCount(0)
  }
  await expect(tabs.getByRole('button', { name: 'More' })).toHaveCount(0)
})

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

test('"Start without a date" keeps the chosen time and closes the date question for good', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'first-run-skip', { own: true })
  const { courseId } = await createCourse(page, 'Skip course', [{ name: 'Graphs' }])
  await page.goto(`/courses/${courseId}`)
  const form = page.getByRole('form', { name: 'Exam date and daily time' })
  await form.getByRole('combobox', { name: 'Typical daily study time' }).click()
  await page.getByRole('option', { name: '1 hour', exact: true }).click()
  await form.getByRole('button', { name: 'Start without a date' }).click()
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/topics/`))
  const saved = (await (await page.request.get(`/api/projects/${courseId}`)).json()).project
  expect(saved.dailyMinutes).toBe(60)
  expect(saved.examDate).toBeNull()
  await page.goto(`/courses/${courseId}`)
  await expect(page.getByRole('heading', { level: 2, name: 'Start studying' })).toBeVisible()
  await expect(page.getByRole('form', { name: 'Exam date and daily time' })).toHaveCount(0)
})

test('on a phone the start button is in the first screen of the last setup step', async ({ page, context }) => {
  await setZoneCookie(context)
  await page.setViewportSize({ width: 390, height: 844 })
  await signUpAndIn(page, 'first-run-phone', { own: true })
  const { courseId } = await createCourse(page, 'Phone setup course', [{ name: 'Graphs' }])
  await page.goto(`/courses/${courseId}`)
  const start = page.getByRole('button', { name: 'Save and start warm-up' })
  await expect(start).toBeVisible()
  const box = await start.boundingBox()
  expect(box).not.toBeNull()
  const bar = await page.getByRole('navigation', { name: 'Course tabs' }).boundingBox()
  expect(box!.y + box!.height).toBeLessThanOrEqual(bar ? bar.y : 844)
})

test('Home greets an account that has not studied as new, with no colour legend yet, and Ask suggests trying first', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'first-run-home', { own: true })
  const { courseId } = await createCourse(page, 'Home course', [{ name: 'Hash tables' }, { name: 'Heaps' }])
  await addFileRow(courseId, 'second.pdf')

  await page.goto('/home')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Welcome(, \w+)?$/)
  await expect(page.getByText('Welcome back')).toHaveCount(0)
  await expect(page.getByText("Here's where you left off.")).toHaveCount(0)
  // Every topic is "Not started": the squares are all grey, so there is no legend to read.
  await expect(page.getByText('One square per topic:')).toHaveCount(0)

  // Ask: the scope is named for what it lists, and the suggestions have the student try first.
  await page.goto(`/courses/${courseId}/ask`)
  await expect(page.getByRole('combobox', { name: 'Ask about' })).toContainText('All topics')
  await expect(page.getByRole('button', { name: /Ask me to explain “Hash tables” in my own words/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Give me a question on “Heaps” to try/ })).toBeVisible()
  await expect(page.getByText(/simple terms|Summarize the main ideas/)).toHaveCount(0)
})
