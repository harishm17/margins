import { expect, test, type Page } from '@playwright/test'
import { addContent, createCourse, createEmptyCourse, addMaterial, makeDue, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// Wayfinding: the next step is one thing everywhere, a course has its own navigation on a phone, the
// heading order starts with the page's h1, and the Review page has one main button.

test.use({ timezoneId: ZONE })

async function dueCourse(page: Page, label: string, due: number, options: { own?: boolean } = {}) {
  const user = await signUpAndIn(page, label, options)
  const emptyId = await createEmptyCourse(page, 'Wayfinding course')
  await addMaterial(page, emptyId)
  const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].slice(0, Math.max(due, 2))
  const course = await createCourse(page, 'Wayfinding course', names.map((name) => ({ name, minutes: 30 })), { existingCourseId: emptyId })
  for (const name of names) await addContent(course.topics[name], { section_notes: `# ${name}\n\nNotes.`, topic_quiz: quizQuestions(2) })
  for (const name of names.slice(0, due)) await makeDue(course.topics[name], user.email, { mastery: 0.4, daysAgo: 2 })
  return { user, course }
}

test.describe('one next step', () => {
  test('Home, the overview, the sidebar and the Review page name the same number of due reviews', async ({ page, context }) => {
    test.setTimeout(240_000)
    await setZoneCookie(context)
    // Its own account: Home counts and orders every course an account has, which other specs change.
    const { course } = await dueCourse(page, 'agree', 3, { own: true })
    const base = `/courses/${course.courseId}`

    await page.goto(base)
    await expect(page.getByText(/3 due for review/).first()).toBeVisible()
    // The sidebar badge, on a wide screen.
    await expect(page.getByRole('navigation', { name: 'Course' }).getByText('3 due for review').first()).toBeAttached()
    const upNext = page.getByRole('region', { name: 'Up next' })
    await expect(upNext).toContainText('Review ')
    await expect(upNext).not.toContainText("You're done for today")

    await page.goto('/home')
    // The account has this course only, so Home counts exactly its three.
    await expect(page.getByRole('heading', { level: 2, name: /Due for review/ })).toContainText('(3)')
    await expect(page.getByRole('region', { name: /Up next/ })).toContainText('Review ')

    await page.goto(`${base}/review`)
    await expect(page.getByRole('heading', { level: 2, name: /Due for review/ })).toContainText('(3)')
  })

  test('with today full and reviews overdue the card does not say the day is done', async ({ page, context }) => {
    test.setTimeout(240_000)
    await setZoneCookie(context)
    const { user, course } = await dueCourse(page, 'full', 3)
    // A short day that is already used up by a quiz.
    await page.request.patch(`/api/projects/${course.courseId}`, { data: { dailyMinutes: 10 } })
    const attempt = await page.request.post(`/api/topics/${course.topics.Delta ?? course.topics.Beta}/quiz-attempts`, {
      data: { answers: { '0': 'true', '1': 'true' } },
    })
    expect(attempt.ok()).toBeTruthy()
    await makeDue(course.topics.Alpha, user.email, { mastery: 0.4, daysAgo: 3 })
    await makeDue(course.topics.Beta, user.email, { mastery: 0.4, daysAgo: 2 })
    await makeDue(course.topics.Gamma, user.email, { mastery: 0.4, daysAgo: 1 })

    await page.goto(`/courses/${course.courseId}`)
    const upNext = page.getByRole('region', { name: 'Up next' })
    await expect(upNext).not.toContainText("You're done for today")
    await expect(upNext).toContainText('Review')
    await page.goto('/home')
    await expect(page.getByRole('region', { name: /Up next/ })).not.toContainText("You're done for today")
  })
})

test.describe('the course overview', () => {
  test('Up next comes before the exam-date line, and the line is a compact row', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'order')
    const emptyId = await createEmptyCourse(page, 'Order course')
    await addMaterial(page, emptyId)
    const course = await createCourse(page, 'Order course', [{ name: 'One', minutes: 30 }, { name: 'Two', minutes: 30 }], { existingCourseId: emptyId })
    await addContent(course.topics.One, { section_notes: '# One\n\nNotes.' })
    await page.goto(`/courses/${course.courseId}`)
    const upNext = page.getByRole('region', { name: 'Up next' })
    const exam = page.getByRole('region', { name: 'When is your exam?' })
    await expect(exam).toBeVisible()
    const [upBox, examBox] = [await upNext.boundingBox(), await exam.boundingBox()]
    // The date is a line in the header: above the next step, not a card between it and the topics.
    expect(examBox!.y).toBeLessThan(upBox!.y)
    expect(examBox!.height).toBeLessThan(80)
  })
})

test.describe('headings', () => {
  test('the first heading of a course page is its h1, not the sidebar label', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'headings')
    const emptyId = await createEmptyCourse(page, 'Heading course')
    await addMaterial(page, emptyId)
    const course = await createCourse(page, 'Heading course', [{ name: 'One', minutes: 30 }, { name: 'Two', minutes: 30 }], { existingCourseId: emptyId })
    await addContent(course.topics.One, { section_notes: '# One\n\nNotes.' })
    for (const path of ['', '/plan', '/review', '/topics', '/ask', '/materials']) {
      await page.goto(`/courses/${course.courseId}${path}`)
      const first = await page.evaluate(() => {
        const heading = document.querySelector('h1, h2, h3, h4, h5, h6')
        return heading ? heading.tagName : null
      })
      expect(first, path || 'overview').toBe('H1')
    }
  })
})

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('a course has a bottom tab bar with targets of at least 44px, and the page shows the course and unit', async ({ page, context }) => {
    test.setTimeout(180_000)
    await setZoneCookie(context)
    await signUpAndIn(page, 'phone')
    const emptyId = await createEmptyCourse(page, 'A course with a long name for a phone')
    await addMaterial(page, emptyId)
    const course = await createCourse(
      page,
      'A course with a long name for a phone',
      [{ name: 'A topic with a rather long name indeed', unit: 'Unit with a long title', minutes: 30 }, { name: 'Second', unit: 'Unit with a long title', minutes: 30 }],
      { existingCourseId: emptyId }
    )
    await addContent(course.topics['A topic with a rather long name indeed'], { section_notes: '# Topic\n\nNotes.' })
    await page.goto(`/courses/${course.courseId}/topics/${course.topics['A topic with a rather long name indeed']}`)

    const tabs = page.getByRole('navigation', { name: 'Course tabs' })
    await expect(tabs).toBeVisible()
    for (const name of ['Overview', 'Plan', 'Topics', 'Ask']) {
      const box = await tabs.getByRole('link', { name }).boundingBox()
      expect(box!.height, name).toBeGreaterThanOrEqual(44)
      expect(box!.width, name).toBeGreaterThanOrEqual(44)
    }
    const more = await tabs.getByRole('button', { name: 'More' }).boundingBox()
    expect(more!.height).toBeGreaterThanOrEqual(44)
    await expect(tabs.getByRole('link', { name: 'Topics' })).toHaveAttribute('aria-current', 'page')

    // The course and the unit are named above the page name, and every step of its path (a course with no concepts: Read, Practice, Quiz) is on screen.
    const crumb = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(crumb.getByText(/A course with a long name for a phone \/ Unit with a long title/)).toBeVisible()
    const study = page.getByRole('navigation', { name: 'Topic path' })
    const edges = await study.evaluate((nav) => {
      const links = [...nav.querySelectorAll('a')].filter((link) => link.offsetParent !== null)
      const row = nav.firstElementChild as HTMLElement
      return { count: links.length, scrolls: row.scrollWidth > row.clientWidth + 1, sw: row.scrollWidth, cw: row.clientWidth }
    })
    expect(edges.count).toBe(3)
    expect(edges.scrolls, JSON.stringify(edges)).toBe(false)

    // More holds the other places in the course.
    await tabs.getByRole('button', { name: 'More' }).click()
    const sheet = page.getByRole('dialog')
    for (const name of ['Review', 'Mock exams', 'Materials', 'Course settings']) {
      await expect(sheet.getByRole('link', { name })).toBeVisible()
    }
    await sheet.getByRole('link', { name: 'Mock exams' }).click()
    await expect(page).toHaveURL(/\/exams$/)
  })

  test('the Review page has one filled button and rows at least 44px tall', async ({ page, context }) => {
    test.setTimeout(240_000)
    await setZoneCookie(context)
    const { course } = await dueCourse(page, 'review-phone', 3)
    await page.goto(`/courses/${course.courseId}/review`)
    await expect(page.getByRole('heading', { level: 2, name: /Due for review/ })).toBeVisible()
    const filled = await page.locator('main button.bg-accent').count()
    expect(filled).toBe(1)
    const links = page.locator('main li h3 a')
    for (let index = 0; index < (await links.count()); index += 1) {
      const box = await links.nth(index).boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
  })
})

test.describe('voice practice', () => {
  test('the Review page links to a focus screen instead of running a session under its lists', async ({ page, context }) => {
    test.setTimeout(240_000)
    await setZoneCookie(context)
    const { course } = await dueCourse(page, 'voice-link', 2)
    await page.goto(`/courses/${course.courseId}/review`)
    await expect(page.getByTestId('voice-lobby')).toHaveCount(0)
    await page.getByRole('link', { name: 'Start voice practice' }).click()
    await expect(page).toHaveURL(new RegExp(`/courses/${course.courseId}/review/voice$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Voice practice' })).toBeVisible()
    // A focus screen: no sidebar, an Exit back to Review.
    await expect(page.getByRole('link', { name: 'Exit' })).toHaveAttribute('href', `/courses/${course.courseId}/review`)
  })
})
