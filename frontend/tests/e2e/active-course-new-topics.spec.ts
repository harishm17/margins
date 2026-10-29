import { expect, test } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { addContent, createCourse, dayIn, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// Finding topics again on an active course does not send it back to setup: the new topics wait as
// "N new topics to review", every screen keeps working from the confirmed topics, and Confirm adds them.

test.use({ timezoneId: ZONE })
test.setTimeout(180_000)

const NEW = ['Bayes rule', 'Markov chains']

test('new topics on an active course wait for review and join the plan when confirmed', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'new-topics')
  const course = await createCourse(
    page,
    'Probability',
    [
      { name: 'Counting', minutes: 30 },
      { name: 'Conditional probability', minutes: 30 },
    ],
    { examDate: dayIn(ZONE, 14), dailyMinutes: 60 }
  )
  await addContent(course.topics.Counting, { section_notes: '# Counting\n\nNotes.' })
  const base = `/courses/${course.courseId}`

  // What re-extraction leaves on an active course: new topics that are not confirmed (the planner
  // does not touch the status once the course is active).
  await withPrisma(async (prisma) => {
    const last = await prisma.topic.count({ where: { projectId: course.courseId } })
    await prisma.topic.createMany({
      data: NEW.map((name, index) => ({ projectId: course.courseId, name, orderIndex: last + index, userConfirmed: false, sourceMaterialIds: [] })),
    })
  })

  // Overview: still the active course (Up next, topic tiles), with the new topics offered for review.
  await page.goto(base)
  await expect(page.getByRole('region', { name: /Up next/ })).toBeVisible()
  const notice = page.getByRole('status').filter({ hasText: '2 new topics to review' })
  await expect(notice).toBeVisible()
  await expect(notice.getByRole('link', { name: 'Review topics' })).toHaveAttribute('href', `${base}/topics?edit=1`)
  await expect(page.getByRole('link', { name: /Bayes rule/, includeHidden: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 2, name: 'Check the topics' })).toHaveCount(0)

  // Home: the same course card, Up next is the plan's step, not setup.
  await page.goto('/home')
  await expect(page.getByRole('link', { name: /Probability/ }).filter({ hasText: '2 new topics to review' })).toBeVisible()

  // Plan: built from the confirmed topics only.
  await page.goto(`${base}/plan`)
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
  await expect(page.getByText('Your plan starts with your topics')).toHaveCount(0)
  await expect(page.getByText(/Bayes rule|Markov chains/).first()).toHaveCount(0)

  // Sidebar dot on Topics, and the new topics are not in the sidebar, the palette or the exam form.
  await expect(page.getByRole('navigation', { name: 'Course' }).getByText('Topics need review').first()).toBeAttached()
  await expect(page.getByRole('link', { name: /Counting/, includeHidden: true }).first()).toBeAttached()
  await expect(page.getByRole('link', { name: /Bayes rule/, includeHidden: true })).toHaveCount(0)
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder(/^Search topics/).fill('Bayes')
  await expect(page.getByText(/Nothing matches/)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.goto(`${base}/exams/new`)
  await expect(page.locator('#main').getByText('Conditional probability', { exact: true })).toBeVisible()
  await expect(page.locator('#main').getByText('Bayes rule', { exact: true })).toHaveCount(0)

  // Topics page: the confirmed list, with the same notice.
  await page.goto(`${base}/topics`)
  await expect(page).toHaveURL(`${base}/topics`)
  await expect(page.getByRole('status').filter({ hasText: '2 new topics to review' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Bayes rule/ })).toHaveCount(0)

  // The editor shows every topic and asks to confirm, not Done.
  await page.goto(`${base}/topics?edit=1`)
  await expect(page.getByRole('heading', { level: 1, name: 'Check the topics' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rename Bayes rule' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm topics' }).click()
  await expect(page).toHaveURL(base)

  // Confirmed: the notice is gone and the new topics are everywhere, including the plan.
  await page.goto(base)
  await expect(page.getByRole('status').filter({ hasText: 'new topics to review' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Bayes rule/ }).first()).toBeVisible()
  await page.goto(`${base}/plan`)
  await expect(page.getByText(/Bayes rule/).first()).toBeAttached()
})

test('a course whose topics were all deleted goes back to step 2', async ({ page, context }) => {
  await setZoneCookie(context)
  await signUpAndIn(page, 'new-topics')
  const course = await createCourse(page, 'Emptied', [{ name: 'Only topic', minutes: 30 }])
  await addContent(course.topics['Only topic'], { section_notes: '# Only\n\nNotes.' })
  await withPrisma((prisma) => prisma.topic.deleteMany({ where: { projectId: course.courseId } }))

  await page.goto(`/courses/${course.courseId}`)
  await expect(page.getByRole('heading', { level: 2, name: 'Check the topics' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'new topics to review' })).toHaveCount(0)
})
