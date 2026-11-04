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
  const stages = page.getByRole('region', { name: 'How a course goes' })
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

test('after the topics are confirmed, setup asks for the exam date, then everything opens', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'first-run-exam', { own: true })
  const { courseId } = await createCourse(page, 'Exam date course', [{ name: 'Bayes rule' }, { name: 'Priors' }])
  await page.goto(`/courses/${courseId}`)

  // Step 3 says what happens inside a topic, and asks for the date the plan depends on.
  await expect(page.getByRole('heading', { level: 2, name: 'Start studying' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Start warm-up: Bayes rule' })).toBeVisible()
  const form = page.getByRole('form', { name: 'Exam date and daily time' })
  await expect(form).toBeVisible()
  await expect(form.getByRole('button', { name: 'Skip for now' })).toBeVisible()

  // The course is ready, so nothing in the menu is held back any more.
  await expect(courseNav(page).getByRole('link', { name: 'Plan', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('setup-progress')).toHaveCount(0)

  // Saving without a date says so; with one, the question goes and the plan has an end.
  await form.getByRole('button', { name: 'Save date and time' }).click()
  await expect(form.getByText('Pick the day of your exam, or skip for now.')).toBeVisible()
  await form.getByLabel('Exam date').fill(dayIn(ZONE, 30))
  await form.getByRole('button', { name: 'Save date and time' }).click()
  await expect(page.getByRole('form', { name: 'Exam date and daily time' })).toHaveCount(0)
  const course = await (await page.request.get(`/api/projects/${courseId}`)).json()
  expect(JSON.stringify(course)).toContain(dayIn(ZONE, 30))
  await expect(page.getByRole('link', { name: 'Start warm-up: Bayes rule' })).toBeVisible()
})

test('"Skip for now" closes the exam date question for good', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'first-run-skip', { own: true })
  const { courseId } = await createCourse(page, 'Skip course', [{ name: 'Graphs' }])
  await page.goto(`/courses/${courseId}`)
  const form = page.getByRole('form', { name: 'Exam date and daily time' })
  await form.getByRole('button', { name: 'Skip for now' }).click()
  await expect(form).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'Start studying' })).toBeVisible()
  await expect(page.getByRole('form', { name: 'Exam date and daily time' })).toHaveCount(0)
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
