import { expect, test, type Page } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { addQuizSet, createCourse, quizQuestions, signIn, signUpAndIn } from './helpers/loop'
import { animationsSettled } from './helpers/settle'

// Quiz and mock exam questions slide the way the student went (Next from the right, Previous from the
// left, a jump fades) and stay still when a session is resumed after a reload.

const { course } = demoIds()

test.use({ viewport: { width: 1440, height: 900 } })

/** The motion class on the question container ('' for none), and its computed animation name. */
const motion = (page: Page) =>
  page.locator('[data-question]').evaluate((el) => ({
    classes: [...el.classList].filter((name) => name.startsWith('animate-')).join(' '),
    animation: getComputedStyle(el).animationName,
  }))

/** A topic of its own with a quiz that has not been taken today: the same questions open again only tomorrow (spec 7.3). */
async function freshQuizUrl(page: Page, label: string) {
  await signUpAndIn(page, label, { own: true })
  const created = await createCourse(page, `Motion ${Date.now()}`, [{ name: 'Graph search' }])
  const topicId = created.topics['Graph search']
  await addQuizSet(topicId, quizQuestions(5))
  return `/courses/${created.courseId}/topics/${topicId}?view=quiz`
}

test('Next slides from the right, Previous from the left, a jump fades, the first question stays still', async ({ page }) => {
  await page.goto(await freshQuizUrl(page, 'motion-a'))
  await page.getByRole('button', { name: 'Start quiz' }).click()
  await expect(page.getByText(/^Question 1 of/)).toBeVisible()
  expect((await motion(page)).classes).toBe('')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByText(/^Question 2 of/)).toBeVisible()
  expect((await motion(page)).classes).toBe('animate-slide-in')
  await page.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(page.getByText(/^Question 1 of/)).toBeVisible()
  expect((await motion(page)).classes).toBe('animate-slide-in-back')
  await page.getByRole('button', { name: /^Question 4/ }).click()
  await expect(page.getByText(/^Question 4 of/)).toBeVisible()
  expect((await motion(page)).classes).toBe('animate-fade-in')
})

test('a quiz resumed after a reload shows its question without moving', async ({ page }) => {
  await page.goto(await freshQuizUrl(page, 'motion-b'))
  await page.getByRole('button', { name: 'Start quiz' }).click()
  for (const n of [2, 3]) {
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByText(new RegExp(`^Question ${n} of`))).toBeVisible()
  }
  await page.reload()
  await expect(page.getByText(/^Question 3 of/)).toBeVisible()
  // Whatever would move has finished moving; a motion class added after the page woke up would still be on the question.
  await animationsSettled(page)
  expect(await motion(page)).toEqual({ classes: '', animation: 'none' })
})

test('a mock exam resumed after a reload shows its question without moving (at 2, and at 4)', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, DEMO_EMAIL)
  await page.goto(`/courses/${course}/exams/new`)
  await page.getByRole('button', { name: 'Change settings' }).click()
  await page.getByRole('radio', { name: '10', exact: true }).click()
  await page.getByRole('radio', { name: '30 min', exact: true }).click()
  await page.getByRole('button', { name: 'Create exam' }).click()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })
  await page.getByRole('button', { name: /^(Start exam|Resume)/ }).click()
  await expect(page).toHaveURL(/\/take$/)
  await expect(page.getByRole('heading', { name: /Question 1 of/ })).toBeVisible()
  expect((await motion(page)).classes).toBe('')

  for (const n of [2, 4]) {
    await page.getByRole('button', { name: new RegExp(`^Question ${n}`) }).click()
    await expect(page.getByRole('heading', { name: new RegExp(`Question ${n} of`) })).toBeVisible()
    // A real move still animates: a step slides, a jump fades.
    expect((await motion(page)).classes).toMatch(/animate-(slide-in|fade-in)/)
    await page.reload()
    await expect(page.getByRole('heading', { name: new RegExp(`Question ${n} of`) })).toBeVisible()
    await animationsSettled(page)
    expect(await motion(page), `resumed at question ${n}`).toEqual({ classes: '', animation: 'none' })
  }
})
