import { expect, test, type Page } from '@playwright/test'
import { expectNoSidewaysScroll } from './helpers/overflow'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'
import { addContent, createCourse, dayIn, makeDue, quizQuestions, setZoneCookie, signIn, signUpAndIn, ZONE } from './helpers/loop'

// No page may scroll sideways on a phone. Every main page is loaded at 390 x 844 (the mock LLM's
// demo course, seeded by global-setup.ts) and the document must be no wider than the window.
// Desktop-only layouts count: they are still opened on a phone sometimes.
test.use({ viewport: { width: 390, height: 844 } })

const { course, setupCourse, topics, mathTopic } = demoIds()
const topic = `/courses/${course}/topics/${topics[0]}`
const math = `/courses/${course}/topics/${mathTopic}`
const PAGES: [string, string][] = [
  ['home', '/home'],
  ['course overview', `/courses/${course}`],
  ['course setup guide', `/courses/${setupCourse}`],
  ['topics list with units', `/courses/${course}/topics`],
  ['topic editor with units', `/courses/${course}/topics?edit=1`],
  ['topic notes with objectives and sources', `${topic}?view=read`],
  ['topic examples', `${topic}?view=examples`],
  ['topic practice', `${topic}?view=practice`],
  ['topic quiz', `${topic}?view=quiz`],
  ['topic voice', `${topic}?view=voice`],
  ['math topic notes', `${math}?view=read`],
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

  // The loading screens count too: while a section's data is held back, its skeleton is the page. The
  // plan's used to be 400px wide on a 390px phone, which pushed the fixed tab bar's labels off screen.
  // These three are the phone's bottom tabs, so they can be tapped.
  for (const section of ['plan', 'topics', 'ask']) {
    test(`the ${section} loading screen fits the window`, async ({ page }) => {
      await page.goto(`/courses/${course}`, { waitUntil: 'networkidle' })
      await page.route('**/*', async (route) => {
        const headers = route.request().headers()
        if (headers['rsc'] === '1' && !headers['next-router-prefetch']) await new Promise((resolve) => setTimeout(resolve, 1500))
        await route.continue()
      })
      await page.locator(`a[href$="/courses/${course}/${section}"]:visible`).first().click()
      await expect(page.locator('main [aria-busy="true"]').first()).toBeVisible()
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      expect(scrollWidth, `the ${section} skeleton is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth)
      await expect(page).toHaveURL(new RegExp(`/${section}$`))
    })
  }

  test('the objectives open on a phone without widening the page', async ({ page }) => {
    await page.goto(topic + '?view=read', { waitUntil: 'networkidle' })
    // One button in the header's status line opens everything the topic covers: its ideas, objectives and sources.
    const toggle = page.locator('main header').getByRole('button', { name: /By the end you can|ideas?, \d+ solid|Details/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // It controls everything it shows or hides: the description (when the topic has one) and the ideas and objectives. Each id exists.
    const controls = ((await toggle.getAttribute('aria-controls')) ?? '').split(' ').filter(Boolean)
    expect(controls.length, 'it names what it controls').toBeGreaterThanOrEqual(1)
    for (const id of controls) await expect(page.locator(`[id="${id}"]`), `controlled element ${id}`).toHaveCount(1)
    if ((await page.locator('main header p[id]').count()) > 0) expect(controls.length, 'the description and the rest').toBe(2)
    await toggle.click()
    await expect(page.getByText('trace merge sort and quicksort on a small array').locator('visible=true')).toBeVisible()
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
  })

  test('graded exam results fit the window', async ({ page }) => {
    // The demo course can hold other exams (other specs write them); take the one that was taken.
    const { exams } = await (await page.request.get(`/api/projects/${course}/exams`)).json()
    const taken = exams.find((exam: { attemptsCount?: number }) => (exam.attemptsCount ?? 0) > 0)
    const { submissions } = await (await page.request.get(`/api/exams/${taken.id}/submissions`)).json()
    await expectNoSidewaysScroll(page, `/courses/${course}/exams/${taken.id}/results/${submissions[0].id}`)
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
