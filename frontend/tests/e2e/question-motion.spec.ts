import { expect, test, type Page } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { signIn } from './helpers/loop'

// Quiz and mock exam questions slide the way the student went (Next from the right, Previous from the
// left, a jump fades) and stay still when a session is resumed after a reload.

const { course, topics } = demoIds()
const topicUrl = `/courses/${course}/topics/${topics[0]}`

test.use({ viewport: { width: 1440, height: 900 } })

/** The motion class on the question container ('' for none), and its computed animation name. */
const motion = (page: Page) =>
  page.locator('[data-question]').evaluate((el) => ({
    classes: [...el.classList].filter((name) => name.startsWith('animate-')).join(' '),
    animation: getComputedStyle(el).animationName,
  }))

test('Next slides from the right, Previous from the left, a jump fades, the first question stays still', async ({ page }) => {
  await signIn(page, DEMO_EMAIL)
  await page.goto(`${topicUrl}?view=quiz`)
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
  await signIn(page, DEMO_EMAIL)
  await page.goto(`${topicUrl}?view=quiz`)
  await page.getByRole('button', { name: 'Start quiz' }).click()
  for (const n of [2, 3]) {
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByText(new RegExp(`^Question ${n} of`))).toBeVisible()
  }
  await page.reload()
  await expect(page.getByText(/^Question 3 of/)).toBeVisible()
  await page.waitForTimeout(400)
  expect(await motion(page)).toEqual({ classes: '', animation: 'none' })
})

test('a mock exam resumed after a reload shows its question without moving (at 2, and at 4)', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, DEMO_EMAIL)
  await page.goto(`/courses/${course}/exams/new`)
  await page.getByRole('radio', { name: '10', exact: true }).click()
  await page.getByRole('radio', { name: '30 min' }).click()
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
    await page.waitForTimeout(400)
    expect(await motion(page), `resumed at question ${n}`).toEqual({ classes: '', animation: 'none' })
  }
})
