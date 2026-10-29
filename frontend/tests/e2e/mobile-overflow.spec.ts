import { expect, test, type Page } from '@playwright/test'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { addContent, createCourse, dayIn, makeDue, quizQuestions, setZoneCookie, signIn, signUpAndIn, ZONE } from './helpers/loop'

// No page may scroll sideways on a phone. Every main page is loaded at 390 x 844 (the mock LLM's
// demo course, seeded by global-setup.ts) and the document must be no wider than the window.
// Desktop-only layouts count: they are still opened on a phone sometimes.
test.use({ viewport: { width: 390, height: 844 } })

/** The elements that stick out past the right edge, for the failure message. */
const overflowing = (page: Page) =>
  page.evaluate(() => {
    const width = window.innerWidth
    // Something inside a box that scrolls or clips on its own does not widen the page.
    const clipped = (element: Element) => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX !== 'visible') return true
      }
      return false
    }
    return [...document.querySelectorAll('body *')]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ element, box }) => box.width > 0 && box.right > width + 0.5 && !clipped(element))
      .slice(0, 8)
      .map(({ element, box }) => {
        const classes = typeof element.className === 'string' ? element.className.split(/\s+/).slice(0, 4).join('.') : ''
        return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''} right=${Math.round(box.right)}`
      })
  })

async function expectNoSidewaysScroll(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth, `${url} is ${scrollWidth}px wide in a ${innerWidth}px window; sticking out: ${(await overflowing(page)).join(', ')}`).toBeLessThanOrEqual(
    innerWidth
  )
}

const { course, setupCourse, topics, mathTopic } = demoIds()
const topic = `/courses/${course}/topics/${topics[0]}`
const math = `/courses/${course}/topics/${mathTopic}`
const PAGES: [string, string][] = [
  ['home', '/home'],
  ['course overview', `/courses/${course}`],
  ['course setup guide', `/courses/${setupCourse}`],
  ['topics list with units', `/courses/${course}/topics`],
  ['topic editor with units', `/courses/${course}/topics?edit=1`],
  ['topic notes with objectives and sources', `${topic}?view=notes`],
  ['topic examples', `${topic}?view=examples`],
  ['topic practice', `${topic}?view=practice`],
  ['topic quiz', `${topic}?view=quiz`],
  ['topic voice', `${topic}?view=voice`],
  ['math topic notes', `${math}?view=notes`],
  ['math topic examples', `${math}?view=examples`],
  ['math topic practice', `${math}?view=practice`],
  ['math topic quiz', `${math}?view=quiz`],
  ['materials with role badges', `/courses/${course}/materials`],
  ['ask', `/courses/${course}/ask`],
  ['mock exams', `/courses/${course}/exams`],
  ['new mock exam', `/courses/${course}/exams/new`],
  ['plan', `/courses/${course}/plan`],
  ['review', `/courses/${course}/review`],
  ['settings', `/courses/${course}/settings`],
]

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
  })

  for (const [name, url] of PAGES) {
    test(`${name} fits the window`, async ({ page }) => {
      await expectNoSidewaysScroll(page, url)
    })
  }

  test('the objectives open on a phone without widening the page', async ({ page }) => {
    await page.goto(topic + '?view=notes', { waitUntil: 'networkidle' })
    const toggle = page.getByRole('button', { name: /By the end you can/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(page.getByText('trace merge sort and quicksort on a small array').locator('visible=true')).toBeVisible()
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
  })

  test('graded exam results fit the window', async ({ page }) => {
    const { exams } = await (await page.request.get(`/api/projects/${course}/exams`)).json()
    const { submissions } = await (await page.request.get(`/api/exams/${exams[0].id}/submissions`)).json()
    await expectNoSidewaysScroll(page, `/courses/${course}/exams/${exams[0].id}/results/${submissions[0].id}`)
  })
})

// The plan and review pages with something on them: a short plan with its warning, the not-scheduled list
// and a final week, and a review list with a due topic and both of its buttons.
test.describe('learning loop pages', () => {
  test.use({ timezoneId: ZONE })

  test('a short plan, with its warning and the list of topics left out, fits the window', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'overflow-plan')
    const names = ['Introduction to probability and counting', 'Conditional probability and independence', 'Discrete random variables', 'Continuous random variables and densities', 'Joint distributions and covariance', 'Limit theorems and approximations']
    const loop = await createCourse(page, 'A course with long topic names to test wrapping', names.map((name) => ({ name, minutes: 60 })), {
      examDate: dayIn(ZONE, 12),
      dailyMinutes: 30,
    })
    await expectNoSidewaysScroll(page, `/courses/${loop.courseId}/plan`)
    await expect(page.getByRole('heading', { level: 2, name: /^Not scheduled/ })).toBeVisible()
    await expectNoSidewaysScroll(page, `/courses/${loop.courseId}/settings`)
  })

  test('the review list with a due topic fits the window', async ({ page, context }) => {
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'overflow-review')
    const loop = await createCourse(page, 'Review overflow', [{ name: 'A topic with a rather long name, to see how the buttons wrap on a phone' }])
    const topic = Object.values(loop.topics)[0]
    await addContent(topic, { topic_quiz: quizQuestions(4) })
    await page.request.post(`/api/topics/${topic}/quiz-attempts`, { data: { answers: { '0': 'true', '1': 'false', '2': 'false', '3': 'true' } } })
    await makeDue(topic, user.email)
    await expectNoSidewaysScroll(page, `/courses/${loop.courseId}/review`)
    await expect(page.getByRole('button', { name: /^Retry what you missed/ })).toBeVisible()
    await expectNoSidewaysScroll(page, `/courses/${loop.courseId}/topics/${topic}?view=quiz`)
  })
})

test.describe('signed out', () => {
  for (const url of ['/', '/login', '/privacy', '/terms']) {
    test(`${url} fits the window`, async ({ page }) => {
      await expectNoSidewaysScroll(page, url)
    })
  }
})
