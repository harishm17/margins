import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openMoreHelp, workingBox } from './helpers/practice'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { markAiAvailable, markAiUnavailable, withPrisma } from './helpers/db'
import {
  ZONE,
  addContent,
  addQuizSet,
  addMaterial,
  createCourse,
  createEmptyCourse,
  dayIn,
  makeDue,
  practiceProblem,
  quizQuestions,
  reviewItem,
  seedDueConcept,
  setZoneCookie,
  signIn,
  signUpAndIn,
} from './helpers/loop'
import { expectClearOfTabBar } from './helpers/overflow'
import { animationsSettled, streamedPartsArrived } from './helpers/settle'
import { chooseConfidence } from './helpers/confidence'

// The learning loop: exam date and plan, practice progress on the server, reviews (retry what you
// missed, fresh review) and graded mock exams that move mastery. Every spec has its own account and
// course; the AI service is the mock, so nothing here costs anything.

test.use({ timezoneId: ZONE })

// Streaming leaves a hidden copy of the page in the DOM for a moment: look at the visible one.
const answer = (page: Page) => page.getByLabel('Your answer').locator('visible=true')

test.describe('plan', () => {
  test('setting the exam date in settings plans the days: learn blocks, a unit mock and two full mocks', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'plan')
    const course = await createCourse(page, 'Plan course', [
      { name: 'Sorting', unit: 'Unit A', minutes: 30 },
      { name: 'Searching', unit: 'Unit A', minutes: 30 },
      { name: 'Hashing', unit: 'Unit A', minutes: 30 },
      { name: 'Graphs', unit: 'Unit B', minutes: 30 },
    ])

    // No date yet: a rolling two weeks, and the page says how to plan up to an exam.
    await page.goto(`/courses/${course.courseId}/plan`)
    await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
    await expect(page.getByText(/A rolling 14-day plan until you set an exam date, planned for 45 minutes a day/).locator('visible=true')).toBeVisible()

    await page.goto(`/courses/${course.courseId}/settings`)
    await page.getByLabel('Exam date').locator('visible=true').fill(dayIn(ZONE, 21))
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Course saved').locator('visible=true')).toBeVisible()

    await page.goto(`/courses/${course.courseId}/plan`)
    await expect(page.getByText(/Your exam is in 21 days/).locator('visible=true')).toBeVisible()

    // Today is highlighted and holds the first learn block, linked to its topic.
    const today = page.locator('[aria-current="date"]')
    await expect(today).toHaveCount(1)
    await expect(today.getByText('Today', { exact: true }).locator('visible=true')).toBeVisible()
    // Today's row opens the topic on its next activity (a topic not read yet: the reading), as Home and the overview do.
    await expect(today.getByRole('link', { name: 'Learn Sorting', exact: true })).toHaveAttribute(
      'href',
      new RegExp(`^/courses/${course.courseId}/topics/${course.topics.Sorting}(\\?view=[a-z]+)?$`)
    )

    // The first quiz is the day after it was learned, and the unit has its mock exam.
    await expect(page.getByRole('link', { name: 'Quiz: Sorting', exact: true, includeHidden: true })).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'Mock exam: Unit A', exact: true, includeHidden: true })).toHaveCount(1)
    // Unit B has one topic, so no unit mock; two full mocks sit in the final week.
    await expect(page.getByRole('link', { name: 'Mock exam: Unit B', exact: true, includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Full mock exam', exact: true, includeHidden: true })).toHaveCount(2)
    // Later days are one line each, and the exam week is open: the badges are on those lines.
    await expect(page.getByText('Exam day', { exact: true }).locator('visible=true')).toBeVisible()
    await expect(page.getByText('Final review', { exact: true }).locator('visible=true')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Time is short/ })).toHaveCount(0)

    // The plan is in the course nav, and the mock links open the form with the topics chosen.
    await expect(page.getByRole('navigation', { name: 'Course' }).getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'page')
    const mock = page.getByRole('link', { name: 'Mock exam: Unit A', exact: true, includeHidden: true })
    await expect(mock).toHaveAttribute('href', new RegExp(`/exams/new\\?topics=`))
  })

  test('when time is short the plan says so, puts past-exam topics first and lists what is not scheduled', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'short')
    const names = ['Intro', 'Basics', 'Middle', 'Later', 'Hard one', 'Hardest']
    const course = await createCourse(
      page,
      'Short on time',
      names.map((name) => ({ name, minutes: 60 })),
      { examDate: dayIn(ZONE, 5), dailyMinutes: 30 }
    )
    // The last two topics appear on the student's past exams.
    await withPrisma((prisma) =>
      prisma.topic.updateMany({ where: { id: { in: [course.topics['Hard one'], course.topics.Hardest] } }, data: { examRelevant: true } })
    )

    await page.goto(`/courses/${course.courseId}/plan`)
    // Until the streamed parts have arrived a hidden copy of each waits in the document, and hidden links count twice below.
    await streamedPartsArrived(page)
    const warning = page.getByRole('alert').filter({ hasText: 'Time is short' })
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('Topics that appear on your past exams come first')

    // Nothing is dropped silently: the rest is listed.
    const heading = page.getByRole('heading', { level: 2, name: /^Not scheduled: \d+ topics?$/ })
    await expect(heading).toBeVisible()
    const listed = await page.locator('section[aria-labelledby="not-scheduled-heading"] li').allInnerTexts()
    const planned = await page.getByRole('link', { name: /^Learn /, includeHidden: true }).evaluateAll((links) => links.map((link) => link.textContent ?? ''))
    const learn = [...new Set(planned.map((text) => text.replace('Learn ', '').trim()))]
    expect([...listed, ...learn].sort()).toEqual([...names].sort())
    expect(learn.length).toBeGreaterThan(0)
    expect(listed.length).toBeGreaterThan(0)
    expect(learn).toContain('Hard one')
    expect(listed).not.toContain('Hard one')
    // Each one still links to its topic.
    await expect(page.locator('section[aria-labelledby="not-scheduled-heading"]').getByRole('link').first()).toHaveAttribute('href', /\/topics\//)
  })

  test('the overview asks "When is your exam?" until a date is set, and Up next reads today\'s plan', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'prompt')
    // A course shows its Today view once it has a file, confirmed topics and some written content.
    const emptyCourse = await createEmptyCourse(page, 'Prompt course')
    await addMaterial(page, emptyCourse)
    const course = await createCourse(
      page,
      'Prompt course',
      [
        { name: 'Sorting', minutes: 30 },
        { name: 'Searching', minutes: 30 },
      ],
      { existingCourseId: emptyCourse }
    )
    await addContent(course.topics.Sorting, { section_notes: '# Sorting\n\nNotes.' })

    await page.goto(`/courses/${course.courseId}`)
    const upNext = page.getByRole('region', { name: 'Up next' })
    await expect(upNext).toContainText('Sorting')
    await expect(upNext.getByRole('link', { name: 'See the plan' })).toHaveAttribute('href', `/courses/${course.courseId}/plan`)
    const card = page.getByRole('region', { name: 'When is your exam?' })
    await expect(card).toBeVisible()

    await card.getByRole('button', { name: 'Set exam date' }).click()
    await card.getByLabel('Exam date').locator('visible=true').fill(dayIn(ZONE, 30))
    await card.getByRole('button', { name: 'Save date' }).click()
    await expect(page.getByRole('region', { name: 'When is your exam?' })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('region', { name: 'When is your exam?' })).toHaveCount(0)

    // Another course: "Not now" closes the card for good.
    const emptyOther = await createEmptyCourse(page, 'No date wanted')
    await addMaterial(page, emptyOther)
    const other = await createCourse(page, 'No date wanted', [{ name: 'One', minutes: 30 }], { existingCourseId: emptyOther })
    await addContent(other.topics.One, { section_notes: '# One' })
    await page.goto(`/courses/${other.courseId}`)
    await page.getByRole('region', { name: 'When is your exam?' }).getByRole('button', { name: 'Set exam date' }).click()
    await page.getByRole('region', { name: 'When is your exam?' }).getByRole('button', { name: 'Not now' }).click()
    await expect(page.getByRole('region', { name: 'When is your exam?' })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('region', { name: 'When is your exam?' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Up next' })).toBeVisible()
  })

  test('on a phone the exam-date card is above the tab bar on the first paint, with its buttons reachable', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'prompt-phone')
    await page.setViewportSize({ width: 390, height: 844 })
    const emptyCourse = await createEmptyCourse(page, 'Prompt phone course')
    await addMaterial(page, emptyCourse)
    const course = await createCourse(page, 'Prompt phone course', [{ name: 'Sorting', minutes: 30 }, { name: 'Searching', minutes: 30 }], { existingCourseId: emptyCourse })
    await addContent(course.topics.Sorting, { section_notes: '# Sorting\n\nNotes.' })
    await page.goto(`/courses/${course.courseId}`)
    const card = page.getByRole('region', { name: 'When is your exam?' })
    await expect(card).toBeVisible()
    const bar = await page.getByRole('navigation', { name: 'Course tabs' }).boundingBox()
    const box = await card.boundingBox()
    expect(bar).not.toBeNull()
    expect(box).not.toBeNull()
    // On the first paint, with nothing scrolled, the whole line (the sentence and its one button) is above the fixed bar.
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    expect(box!.y + box!.height, `the exam-date line ends at ${Math.round(box!.y + box!.height)}px, the tab bar starts at ${Math.round(bar!.y)}px`).toBeLessThanOrEqual(bar!.y)
    await screenshotIfAsked(page, 'final-exam-prompt-390x844')
    // The date field and its two buttons open from the one button, and stay clear of the bar.
    await expectClearOfTabBar(page, card.getByRole('button', { name: 'Set exam date' }), 'Set exam date')
    await card.getByRole('button', { name: 'Set exam date' }).click()
    await expectClearOfTabBar(page, card.getByRole('button', { name: 'Save date' }), 'Save date')
  })

  test('the exam date and the daily time can be set when the course is created', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'create')
    await page.goto('/courses/new')
    await page.getByLabel('Course name').locator('visible=true').fill('Dated course')
    await page.getByLabel('Exam date').locator('visible=true').fill(dayIn(ZONE, 40))
    // The daily time waits behind "More details".
    await page.getByText('More details').click()
    await page.getByRole('combobox', { name: 'Typical daily study time' }).click()
    await page.getByRole('option', { name: '1 hour 30 minutes' }).click()
    await page.getByRole('button', { name: 'Create course' }).click()
    await expect(page).toHaveURL(/\/courses\/[0-9a-f-]{36}$/)
    const courseId = page.url().split('/').pop() as string
    const row = await withPrisma((prisma) => prisma.project.findUniqueOrThrow({ where: { id: courseId } }))
    expect(row.examDate?.toISOString().slice(0, 10)).toBe(dayIn(ZONE, 40))
    expect(row.dailyMinutes).toBe(90)

    await page.goto(`/courses/${courseId}/settings`)
    await expect(page.getByLabel('Exam date').locator('visible=true')).toHaveValue(dayIn(ZONE, 40))
    await expect(page.getByRole('combobox', { name: 'Typical daily study time' })).toContainText('1 hour 30 minutes')
  })
})

test.describe('practice progress', () => {
  test('a change still waiting out its moment is sent when the page is left, not lost', async ({ page }) => {
    // The moment (250 ms) never ends on this page, as when the student closes the tab inside it.
    await page.addInitScript(() => {
      const original = window.setTimeout
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => (delay === 250 ? 0 : original(handler, delay, ...rest))) as typeof window.setTimeout
    })
    await signUpAndIn(page, 'practice-leave')
    const course = await createCourse(page, 'Practice leave', [{ name: 'Squares' }])
    await addContent(course.topics.Squares, { interactive_examples: [practiceProblem('Squares')] })
    await page.goto(`/courses/${course.courseId}/topics/${course.topics.Squares}?view=practice`)
    await answer(page).fill('4')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.getByText('1 of 2 solved').locator('visible=true')).toBeVisible()
    const progress = () => page.request.get(`/api/topics/${course.topics.Squares}/practice-progress`).then((response) => response.json())
    // Nothing has been sent: the timer did not fire.
    expect((await progress()).problems).toHaveLength(0)
    await page.goto('about:blank')
    await expect.poll(async () => (await progress()).problems[0]?.solvedSteps).toEqual([0])
  })

  test('is kept on the server: it follows the student to another browser, scores a finished problem and moves mastery', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000)
    const user = await signUpAndIn(page, 'practice')
    const course = await createCourse(page, 'Practice course', [{ name: 'Squares' }, { name: 'Cubes' }])
    await addContent(course.topics.Squares, { interactive_examples: [practiceProblem('Squares')] })
    await addContent(course.topics.Cubes, { interactive_examples: [practiceProblem('Cubes')] })
    const squares = `/courses/${course.courseId}/topics/${course.topics.Squares}?view=practice`

    // Device one: solve the first step.
    await page.goto(squares)
    await answer(page).fill('4')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
    await expect(page.getByText('1 of 2 solved').locator('visible=true')).toBeVisible()
    await expect
      .poll(async () => (await (await page.request.get(`/api/topics/${course.topics.Squares}/practice-progress`)).json()).problems[0]?.solvedSteps)
      .toEqual([0])

    // Device two: a browser with nothing stored sees it.
    const other = await browser.newContext({ timezoneId: ZONE })
    const phone = await other.newPage()
    await signIn(phone, user.email)
    await phone.goto(squares)
    await expect(phone.getByText('1 of 2 solved').locator('visible=true')).toBeVisible()
    // It resumes at the second step, misses once (Connect waits for an attempt), takes the hint, finishes.
    await answer(phone).fill('5')
    await phone.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(phone.getByText('Not quite').locator('visible=true')).toBeVisible()
    await phone.getByRole('button', { name: 'Try again' }).click()
    await phone.getByRole('button', { name: /Show the first step/ }).click()
    await answer(phone).fill('9')
    await phone.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(phone.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
    await expect(phone.getByText('2 of 2 solved').locator('visible=true')).toBeVisible()
    await phone.getByRole('button', { name: 'Finish' }).click()
    await expect(phone.getByText('Problem complete').locator('visible=true')).toBeVisible()

    // A finished problem is a practice signal: 1 step of 2 solved without a hint is 0.5.
    await expect
      .poll(() =>
        withPrisma((prisma) =>
          prisma.learningSignal.findMany({ where: { topicId: course.topics.Squares, source: 'practice' }, select: { score: true } })
        )
      )
      .toEqual([{ score: 0.5 }])
    const schedule = await withPrisma((prisma) => prisma.reviewSchedule.findFirst({ where: { topicId: course.topics.Squares } }))
    expect(schedule?.mastery).toBeCloseTo(0.5, 5)
    await phone.reload()
    await expect(phone.getByText('Getting there').locator('visible=true').first()).toBeVisible()
    await other.close()

    // Device one again, after a reload with its own cache cleared: still done.
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await expect(page.getByText('2 of 2 solved').locator('visible=true')).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Practice/ }).getByRole('img', { name: 'Completed' })
    ).toBeVisible()

    // Starting over is stored too.
    await page.getByRole('button', { name: 'Start over' }).click()
    await expect(page.getByText('0 of 2 solved').locator('visible=true')).toBeVisible()
    await expect
      .poll(async () => (await (await page.request.get(`/api/topics/${course.topics.Squares}/practice-progress`)).json()).problems[0]?.solvedSteps)
      .toEqual([])
  })

  test('hints say what they cost on request, and the first step, the method and Show answer wait for an attempt', async ({ page }) => {
    test.setTimeout(120_000)
    await signUpAndIn(page, 'rungs')
    const course = await createCourse(page, 'Rungs course', [{ name: 'Squares' }])
    const problem = practiceProblem('Squares')
    const hinted = {
      ...problem,
      steps: problem.steps.map((step) => ({ ...step, hints: ['Look at the number.', 'Squaring is repeated product.', 'n times n.'] })),
    }
    await addContent(course.topics.Squares, { interactive_examples: [hinted] })
    await page.goto(`/courses/${course.courseId}/topics/${course.topics.Squares}?view=practice`)

    const reveal = page.getByRole('button', { name: 'Show answer' }).locator('visible=true')
    // Show answer is not offered before an attempt. The help is one button with one hint ladder: the cost is on the next hint
    // before it is clicked, and Connect and Structure wait for an attempt (spec 18.4).
    await expect(reveal).toHaveCount(0)
    await page.getByRole('button', { name: 'Get help' }).click()
    await expect(page.getByRole('button', { name: /Show where to look/ })).toBeEnabled()
    // The cost is not on the button: it is said on request, under it.
    await expect(page.getByRole('button', { name: /Show where to look/ })).not.toContainText(/harder one/)
    await page.getByRole('button', { name: 'How hints count' }).click()
    await expect(page.getByText('Opening this hint: your next try still counts, as a harder one.')).toBeVisible()
    await page.getByRole('button', { name: /Show where to look/ }).click()
    await expect(page.getByText('Look at the number.').locator('visible=true')).toBeVisible()
    await expect(page.getByRole('button', { name: /Show the first step/ })).toBeDisabled()
    await expect(reveal).toHaveCount(0)
    // A reload keeps the opened hint and the gate.
    await expect
      .poll(async () => (await (await page.request.get(`/api/topics/${course.topics.Squares}/practice-progress`)).json()).problems[0]?.maxRungs)
      .toEqual({ '0': 1 })
    await page.reload()
    await expect(page.getByText('Look at the number.').locator('visible=true')).toBeVisible()
    await expect(reveal).toHaveCount(0)
    await page.getByRole('button', { name: 'Get help' }).click()
    await expect(page.getByRole('button', { name: /Show the first step/ })).toBeDisabled()

    // One wrong check is the attempt: now Connect and Structure open, and Show answer.
    await answer(page).fill('5')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    await page.getByRole('button', { name: /Show the first step/ }).click()
    await page.getByRole('button', { name: /Show the method/ }).click()
    await expect(reveal).toBeEnabled()
    // Opened hints count after a reload too.
    await expect
      .poll(async () => (await (await page.request.get(`/api/topics/${course.topics.Squares}/practice-progress`)).json()).problems[0]?.maxRungs)
      .toEqual({ '0': 4 })
    await page.reload()
    await openMoreHelp(page)
    await expect(reveal).toBeEnabled()
    await reveal.click()
    await expect(page.getByText("The answer is shown, so this step won't count as solved", { exact: false }).locator('visible=true')).toBeVisible()
    await expect
      .poll(async () => (await (await page.request.get(`/api/topics/${course.topics.Squares}/practice-progress`)).json()).problems[0])
      .toMatchObject({ revealedSteps: [0], maxRungs: { '0': 4 } })

    // A refused state: the API will not store a shown answer on a step with no attempt (409 ATTEMPT_FIRST, spec 18.4).
    const refused = await page.request.post(`/api/topics/${course.topics.Squares}/practice-progress`, {
      data: {
        problemIndex: 0,
        problemTitle: 'Squares',
        solvedSteps: [0],
        revealedSteps: [1],
        hintedSteps: [],
        attemptedSteps: [0],
        firstTrySteps: [0],
        maxRungs: {},
      },
    })
    expect(refused.status()).toBe(409)
    expect((await refused.json()).code).toBe('ATTEMPT_FIRST')
    // And the API will not store Connect (rung 3) or more on a step with no attempt either.
    const noAttempt = await page.request.post(`/api/topics/${course.topics.Squares}/practice-progress`, {
      data: { problemIndex: 0, problemTitle: 'Squares', solvedSteps: [], revealedSteps: [], hintedSteps: [1], attemptedSteps: [], firstTrySteps: [], maxRungs: { '1': 3 } },
    })
    expect(noAttempt.status()).toBe(409)
  })

  test('Your working box, the tripped-up prompt after a miss, and no prompt after a clean problem', async ({ page }) => {
    test.setTimeout(120_000)
    await signUpAndIn(page, 'tripped')
    const course = await createCourse(page, 'Tripped course', [{ name: 'Squares' }, { name: 'Cubes' }])
    await addContent(course.topics.Squares, { interactive_examples: [practiceProblem('Squares')] })
    await addContent(course.topics.Cubes, { interactive_examples: [practiceProblem('Cubes')] })
    const progressOf = async (topic: string) => (await (await page.request.get(`/api/topics/${topic}/practice-progress`)).json()).problems[0]

    await page.goto(`/courses/${course.courseId}/topics/${course.topics.Squares}?view=practice`)
    // The working box is optional and does not change the check.
    const working = await workingBox(page)
    await expect(working).toBeVisible()
    await working.fill('2 times 2, maybe 5?')
    await answer(page).fill('5')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    await answer(page).fill('4')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.getByText('Correct', { exact: true }).locator('visible=true')).toBeVisible()
    await expect.poll(async () => (await progressOf(course.topics.Squares))?.missRungs).toEqual({ '0': 0 })
    await page.getByRole('button', { name: 'Next step' }).click()
    await answer(page).fill('9')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await page.getByRole('button', { name: 'Finish' }).click()
    await expect(page.getByText('Problem complete').locator('visible=true')).toBeVisible()

    // A wrong check was stored, so the prompt shows; the line is saved when the box loses focus.
    const tripped = page.getByLabel('What tripped you up? (optional)').locator('visible=true')
    await expect(tripped).toBeVisible()
    await tripped.fill('I read 2 squared as 2 times 3')
    await tripped.blur()
    await expect.poll(async () => (await progressOf(course.topics.Squares))?.trippedUp).toBe('I read 2 squared as 2 times 3')
    // It follows the student: with the browser's cache cleared the saved line comes back.
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await expect(page.getByLabel('What tripped you up? (optional)').locator('visible=true')).toHaveValue('I read 2 squared as 2 times 3')

    // A problem finished with no wrong check shows no prompt.
    await page.goto(`/courses/${course.courseId}/topics/${course.topics.Cubes}?view=practice`)
    await answer(page).fill('4')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await page.getByRole('button', { name: 'Next step' }).click()
    await answer(page).fill('9')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await page.getByRole('button', { name: 'Finish' }).click()
    await expect(page.getByText('Problem complete').locator('visible=true')).toBeVisible()
    await expect(page.getByLabel('What tripped you up? (optional)')).toHaveCount(0)
  })

  test('a refused save puts the browser back to the server and says so', async ({ page }) => {
    test.setTimeout(120_000)
    await signUpAndIn(page, 'refused')
    const course = await createCourse(page, 'Refused course', [{ name: 'Squares' }])
    await addContent(course.topics.Squares, { interactive_examples: [practiceProblem('Squares')] })
    let refusals = 0
    await page.route('**/api/topics/*/practice-progress', async (route) => {
      if (route.request().method() === 'POST' && refusals === 0) {
        refusals += 1
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'A rung cannot go down.' } }) })
      } else await route.continue()
    })
    await page.goto(`/courses/${course.courseId}/topics/${course.topics.Squares}?view=practice`)
    await answer(page).fill('4')
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    // The server never stored the step, so the page goes back to it and tells the student.
    const notice = page.getByRole('alert').filter({ hasText: 'That change could not be saved.' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('This page now shows your last saved progress.')
    await expect(page.getByText('0 of 2 solved').locator('visible=true')).toBeVisible()
    // The step itself is open again: no "Correct", no Next step, and Check is back.
    await expect(page.getByText('Correct', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Next step' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Check', exact: true }).locator('visible=true')).toBeVisible()
    await expect(page.getByText('Solved', { exact: true })).toHaveCount(0)
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expect(notice).toHaveCount(0)
    expect(refusals).toBe(1)
  })

  test('the practice page: no axe violations at desktop and phone width, screenshots on request', async ({ page }) => {
    test.setTimeout(120_000)
    await signUpAndIn(page, 'axe')
    const course = await createCourse(page, 'Axe course', [{ name: 'Squares' }])
    const problem = practiceProblem('Squares')
    const hinted = {
      ...problem,
      steps: problem.steps.map((step) => ({ ...step, hints: ['Look at the number.', 'Squaring is repeated product.', 'n times n.'] })),
    }
    await addContent(course.topics.Squares, { interactive_examples: [hinted] })
    const axe = readFileSync(require.resolve('axe-core'), 'utf8')
    const shots = process.env.SCREENS_DIR
    const checkAxe = async (label: string) => {
      await page.evaluate(axe)
      const violations = await page.evaluate(async () => {
        const run = (window as unknown as { axe: { run: (context: Document) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } }).axe.run
        const result = await run(document)
        return result.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.html.slice(0, 120)).join(' | '))
      })
      expect(violations, label).toEqual([])
    }
    for (const [name, size] of [
      ['1440x900', { width: 1440, height: 900 }],
      ['390x844', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size)
      await page.goto(`/courses/${course.courseId}/topics/${course.topics.Squares}?view=practice`)
      await expect(page.getByRole('button', { name: 'Get help' })).toBeVisible()
      if (shots) await page.screenshot({ path: `${shots}/practice-${name}-start.png` })
      await page.getByRole('button', { name: 'Get help' }).click()
      await page.getByRole('button', { name: /Show where to look/ }).click()
      // Connect and Structure wait for an attempt: a wrong check opens them.
      await answer(page).fill('5')
      await page.getByRole('button', { name: 'Check', exact: true }).click()
      await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
      await page.getByRole('button', { name: 'Try again' }).click()
      // After a miss the helps stay open.
      await page.getByRole('button', { name: /Show the first step/ }).click()
      await checkAxe(`${name}, hints open`)
      await answer(page).fill('5')
      await page.getByRole('button', { name: 'Check', exact: true }).click()
      await expect(page.getByText('Not quite').locator('visible=true')).toBeVisible()
      if (shots) {
        // Let the top bar finish its scrolled style before the picture.
        await animationsSettled(page)
        await page.screenshot({ path: `${shots}/practice-${name}-after-miss.png` })
      }
      await checkAxe(`${name}, after a wrong check`)
      // Reset for the next size.
      await page.evaluate(() => localStorage.clear())
      await page.request.post(`/api/topics/${course.topics.Squares}/practice-progress`, {
        data: { problemIndex: 0, problemTitle: 'Squares', solvedSteps: [], revealedSteps: [], hintedSteps: [], attemptedSteps: [], firstTrySteps: [], maxRungs: {}, missRungs: {} },
      })
    }
  })

  test('progress that only the browser had is uploaded once, without being scored', async ({ page, browser }) => {
    test.setTimeout(120_000)
    const user = await signUpAndIn(page, 'migrate')
    const course = await createCourse(page, 'Migration course', [{ name: 'Cubes' }])
    await addContent(course.topics.Cubes, { interactive_examples: [practiceProblem('Cubes')] })

    // The old browser store: both steps of the problem solved, kept in localStorage only.
    const context = await browser.newContext({ timezoneId: ZONE })
    await context.addInitScript(
      ([topicId]) => {
        window.localStorage.setItem(`margins:practice:${topicId}`, JSON.stringify({ solved: ['0|Cubes|0', '0|Cubes|1'], revealed: [] }))
      },
      [course.topics.Cubes]
    )
    const old = await context.newPage()
    await signIn(old, user.email)
    await old.goto(`/courses/${course.courseId}/topics/${course.topics.Cubes}?view=practice`)
    await expect(old.getByText('Problem complete').locator('visible=true')).toBeVisible()
    await expect
      .poll(async () => (await (await page.request.get(`/api/topics/${course.topics.Cubes}/practice-progress`)).json()).problems[0]?.solvedSteps)
      .toEqual([0, 1])
    // It was practice done before the server kept any: stored, but not counted as a new result.
    const signals = await withPrisma((prisma) => prisma.learningSignal.count({ where: { topicId: course.topics.Cubes, source: 'practice' } }))
    expect(signals).toBe(0)
    await context.close()
  })
})

test.describe('reviews', () => {
  test('a due topic offers new questions focused on what was missed, and "Retry what you missed" runs a quiz of those questions', async ({ page }) => {
    test.setTimeout(240_000)
    const user = await signUpAndIn(page, 'review')
    const courseId = await createEmptyCourse(page, 'Review course')
    await addMaterial(page, courseId)
    const course = await createCourse(
      page,
      'Review course',
      [{ name: 'Sorting algorithms', minutes: 30 }, { name: 'Graph traversal', minutes: 30, after: 'Sorting algorithms' }],
      { existingCourseId: courseId }
    )
    const graph = course.topics['Graph traversal']
    await addContent(graph, { section_notes: '# Graph traversal\n\nNotes.', topic_quiz: quizQuestions(4) })

    // A quiz with two questions wrong, and the review is due.
    const attempt = await page.request.post(`/api/topics/${graph}/quiz-attempts`, {
      data: { answers: { '0': 'true', '1': 'false', '2': 'false', '3': 'true' } },
    })
    expect(attempt.ok()).toBeTruthy()
    expect((await attempt.json()).score).toBe(50)
    await makeDue(graph, user.email, { mastery: 0.5 })

    await page.goto(`/courses/${courseId}/review`)
    await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: /Due for review/ })).toBeVisible()
    const card = page.locator(`#review-${graph}:visible`)
    await expect(card).toContainText('You missed 2 questions lately.')
    // The identical questions wait for the next local day; the new questions do not.
    await expect(card.getByRole('button', { name: 'Retry what you missed for Graph traversal' })).toBeDisabled()
    await expect(card).toContainText('Available tomorrow')
    await expect(card.getByRole('button', { name: 'Fix it now for Graph traversal' })).toBeEnabled()

    // The server holds it too, not only the page.
    const early = await page.request.post(`/api/topics/${graph}/retry-quiz`)
    expect(early.status()).toBe(409)
    expect((await early.json()).error.message).toContain('Available tomorrow')

    // A day later the retry opens.
    await withPrisma((prisma) =>
      prisma.quizAttempt.updateMany({ where: { topicId: graph }, data: { takenAt: new Date(Date.now() - 2 * 86_400_000) } })
    )
    await page.reload()
    await expect(card.getByRole('button', { name: 'Retry what you missed for Graph traversal' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Fix it now for Graph traversal' })).toBeVisible()
    await expect(page.locator(`#review-${course.topics['Sorting algorithms']}`)).toHaveCount(0)

    // New questions: a new 6-question set, focused on the concepts that were missed, with a question
    // or two from the prerequisite topic. It is written by the regeneration path.
    await card.getByRole('button', { name: 'Fix it now for Graph traversal' }).click()
    await expect(page).toHaveURL(/view=quiz/)
    await expect(page.getByRole('combobox', { name: 'Quiz set' })).toBeVisible({ timeout: 120_000 })
    const job = await withPrisma((prisma) =>
      prisma.processingJob.findFirstOrThrow({ where: { targetKey: `content:${graph}:topic_quiz` }, orderBy: { createdAt: 'desc' } })
    )
    const preferences = (job.inputData as { preferences: Record<string, unknown> }).preferences
    expect(preferences.question_count).toBe(6)
    expect(preferences.focus).toBe('Concepts you missed: Concept 2; Concept 3')
    expect(['easy', 'medium', 'hard']).toContain(preferences.difficulty_level)
    expect(preferences.prerequisite_topic_id).toBe(course.topics['Sorting algorithms'])
    expect(preferences.regeneration).toBe(true)

    // Retry what you missed: a quiz of exactly those two questions, no model call.
    await page.goto(`/courses/${courseId}/review`)
    const sets = await withPrisma((prisma) => prisma.topicQuiz.count({ where: { topicId: graph } }))
    await page.locator(`#review-${graph}:visible`).getByRole('button', { name: 'Retry what you missed for Graph traversal' }).click()
    await expect(page.getByText('Question 1 of 2').locator('visible=true')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Statement 2 about graphs holds.' })).toBeVisible()
    expect(await withPrisma((prisma) => prisma.topicQuiz.count({ where: { topicId: graph } }))).toBe(sets + 1)
    // The address drops ?start=1, so a reload keeps the answers instead of starting over.
    await expect(page).not.toHaveURL(/start=1/)
    await page.keyboard.press('t')
    await page.reload()
    await expect(page.getByText('Question 1 of 2').locator('visible=true')).toBeVisible()
    await expect(page.getByRole('radio', { name: /True/ })).toBeChecked()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Statement 3 about graphs holds.' })).toBeVisible()
    await page.keyboard.press('t')
    await page.getByRole('button', { name: 'Submit quiz' }).click()
    await expect(page.getByRole('heading', { name: /2 of 2 points/ })).toBeVisible({ timeout: 60_000 })

    // The attempt moved mastery and pushed the review out.
    const schedule = await withPrisma((prisma) => prisma.reviewSchedule.findFirstOrThrow({ where: { topicId: graph } }))
    expect(schedule.dueAt.getTime()).toBeGreaterThan(Date.now())
    await page.goto(`/courses/${courseId}/review`)
    await expect(page.getByRole('heading', { name: 'Nothing is due' }).first()).toBeVisible()

    // Due again, and now nothing is left to retry: only the new questions are offered.
    await makeDue(graph, user.email, { mastery: 0.7 })
    await page.reload()
    const again = page.locator(`#review-${graph}:visible`)
    await expect(again).toContainText('No missed questions to retry.')
    await expect(again.getByRole('button', { name: /^Retry what you missed/ })).toHaveCount(0)
    await expect(again.getByRole('button', { name: 'Fix it now for Graph traversal' })).toBeVisible()

    // The retry is also offered on the topic's own quiz page while it is due.
    await page.goto(`/courses/${courseId}/topics/${graph}?view=quiz`)
    await expect(page.getByRole('heading', { name: 'Due for review' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Fix it now' })).toBeVisible()
  })
})

test.describe('graded exams', () => {
  test('grading a mock exam moves mastery and reschedules reviews, once', async ({ page }) => {
    test.setTimeout(240_000)
    const user = await signUpAndIn(page, 'exam')
    const course = await createCourse(page, 'Exam course', [{ name: 'Strong topic' }, { name: 'Weak topic' }])
    const [strong, weak] = [course.topics['Strong topic'], course.topics['Weak topic']]
    await addContent(strong, { section_notes: '# Strong' })

    // A mock exam with two questions on each topic (written straight to the database).
    const questions = [strong, strong, weak, weak].map((topicId, index) => ({
      question_type: 'true_false',
      question_text: `Exam statement ${index + 1} holds.`,
      correct_answer: true,
      explanation: 'It does.',
      points: 1,
      topic_id: topicId,
      topic_name: topicId === strong ? 'Strong topic' : 'Weak topic',
      concepts_tested: [],
    }))
    const examId = await withPrisma(async (prisma) =>
      (
        await prisma.sampleExam.create({
          data: {
            projectId: course.courseId,
            name: 'Sample Exam - 2026-10-21',
            questions,
            durationMinutes: 30,
            difficultyLevel: 'medium',
            topicsCovered: ['Strong topic', 'Weak topic'],
          },
          select: { id: true },
        })
      ).id
    )

    // The student gets both questions on one topic right and both on the other wrong.
    expect((await page.request.post(`/api/exams/${examId}/attempt`)).ok()).toBeTruthy()
    const answers = { '0': true, '1': true, '2': false, '3': false }
    const submitted = await page.request.post(`/api/exams/${examId}/submit`, { data: { answers } })
    expect(submitted.ok()).toBeTruthy()
    const { jobId, submissionId } = await submitted.json()
    await expect
      .poll(async () => (await (await page.request.get(`/api/jobs/${jobId}`)).json()).status, { timeout: 120_000 })
      .toBe('completed')

    // Graded, but nobody has looked at it: no review exists yet.
    expect(await withPrisma((prisma) => prisma.reviewSchedule.count({ where: { topicId: { in: [strong, weak] } } }))).toBe(0)
    const before = await withPrisma((prisma) => prisma.examSubmission.findUniqueOrThrow({ where: { id: submissionId }, select: { reviewAppliedAt: true } }))
    expect(before.reviewAppliedAt).toBeNull()

    // Opening the results applies it.
    await page.goto(`/courses/${course.courseId}/exams/${examId}/results/${submissionId}`)
    await expect(page.getByRole('heading', { name: 'Where to focus' })).toBeVisible({ timeout: 120_000 })
    const schedules = await withPrisma((prisma) =>
      prisma.reviewSchedule.findMany({ where: { topicId: { in: [strong, weak] } }, select: { topicId: true, mastery: true, intervalDays: true, dueAt: true } })
    )
    const byTopic = Object.fromEntries(schedules.map((row) => [row.topicId, row]))
    expect(byTopic[strong].mastery).toBeCloseTo(1, 5)
    expect(byTopic[strong].intervalDays).toBe(14)
    expect(byTopic[weak].mastery).toBeCloseTo(0, 5)
    expect(byTopic[weak].intervalDays).toBe(1)
    const marked = await withPrisma((prisma) => prisma.examSubmission.findUniqueOrThrow({ where: { id: submissionId }, select: { reviewAppliedAt: true } }))
    expect(marked.reviewAppliedAt).not.toBeNull()

    // Seen again, it is not applied a second time (the schedule is untouched).
    const dueBefore = byTopic[weak].dueAt.getTime()
    await page.reload()
    await page.goto(`/courses/${course.courseId}`)
    const after = await withPrisma((prisma) => prisma.reviewSchedule.findFirstOrThrow({ where: { topicId: weak } }))
    expect(after.dueAt.getTime()).toBe(dueBefore)

    // The topic page shows the new mastery, and the weak topic is due for review soon.
    await page.goto(`/courses/${course.courseId}/topics/${strong}?view=read`)
    await expect(page.getByText(/Strong\s+(99|100)%/).locator('visible=true').first()).toBeVisible()
    await page.goto(`/courses/${course.courseId}/topics/${weak}?view=read`)
    await expect(page.getByText(/Learning\s+0%/).locator('visible=true').first()).toBeVisible()
    void user
  })
})

test.describe('evidence backfill', () => {
  test('opening the overview turns history from before the concept graph into evidence, once, and concept mastery takes over', async ({ page, context }) => {
    test.setTimeout(120_000)
    await setZoneCookie(context)
    // Its own account: the others in this run share one, and a spare course would change what Home puts first.
    await signIn(page, `backfill-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`)
    const course = await createCourse(page, 'Backfill course', [{ name: 'Graphs', minutes: 30 }, { name: 'Trees', minutes: 30 }])
    const graphs = course.topics.Graphs
    const trees = course.topics.Trees
    await addContent(graphs, { section_notes: '# Graphs', topic_quiz: quizQuestions(4) })

    // A quiz taken before any concept existed: three of four right.
    const attempt = await page.request.post(`/api/topics/${graphs}/quiz-attempts`, {
      data: { answers: { '0': 'true', '1': 'true', '2': 'true', '3': 'false' } },
    })
    expect(attempt.ok()).toBeTruthy()
    const graded = await attempt.json()
    expect(graded.score).toBe(75)
    const attemptId = graded.attempt.id as string
    const blend = await withPrisma((prisma) => prisma.reviewSchedule.findFirstOrThrow({ where: { topicId: graphs } }))

    // The concept graph arrives for both topics, and the stored questions are tagged with their concept.
    const conceptId = await withPrisma(async (prisma) => {
      const make = (topicId: string, name: string) =>
        prisma.concept.create({ data: { projectId: course.courseId, topicId, name, summary: 's', kind: 'concept', orderIndex: 0 }, select: { id: true } })
      const concept = await make(graphs, 'Graph')
      await make(trees, 'Tree')
      return concept.id
    })
    await addContent(graphs, { topic_quiz: quizQuestions(4).map((question) => ({ ...question, concept_ids: [conceptId] })) })
    expect(await withPrisma((prisma) => prisma.evidenceEvent.count({ where: { projectId: course.courseId } }))).toBe(0)

    await page.goto(`/courses/${course.courseId}`)
    await expect
      .poll(
        async () =>
          (await withPrisma((prisma) => prisma.project.findUniqueOrThrow({ where: { id: course.courseId }, select: { evidenceBackfilledAt: true } })))
            .evidenceBackfilledAt,
        { timeout: 30_000 }
      )
      .not.toBeNull()
    await expect
      .poll(() => withPrisma((prisma) => prisma.evidenceEvent.count({ where: { projectId: course.courseId } })), { timeout: 30_000 })
      .toBe(4)
    const events = await withPrisma((prisma) => prisma.evidenceEvent.findMany({ where: { projectId: course.courseId }, orderBy: { itemKey: 'asc' } }))
    expect(events.map((event) => [event.source, event.score, event.assistance])).toEqual([
      ['quiz', 1, 0],
      ['quiz', 1, 0],
      ['quiz', 1, 0],
      ['quiz', 0, 0],
    ])
    expect(events.every((event) => (event.metadata as { backfillOf?: string }).backfillOf === attemptId)).toBeTruthy()

    // The topic's schedule now comes from its concept: one session of answers cannot be solid, so it is below the blend.
    await expect
      .poll(async () => (await withPrisma((prisma) => prisma.reviewSchedule.findFirstOrThrow({ where: { topicId: graphs } }))).mastery, { timeout: 30_000 })
      .toBeLessThan(blend.mastery)

    // Opened again, nothing is written a second time.
    await page.reload()
    await page.goto(`/courses/${course.courseId}`)
    expect(await withPrisma((prisma) => prisma.evidenceEvent.count({ where: { projectId: course.courseId } }))).toBe(4)
  })
})

// Review sessions (spec §7.4): today's review draws on the due concepts of every topic, the student sets
// the pace, and nothing that was missed ends the session unretested. Concepts and their items are written
// straight into the database; the AI service is the mock.
test.describe('review sessions', () => {
  test.afterEach(markAiAvailable)

  const sessionIdOf = (page: Page) => new URL(page.url()).searchParams.get('session') as string
  const checkTrue = async (page: Page, options: { confidence?: string } = {}) => {
    await page.getByRole('radio', { name: /True/ }).click()
    if (options.confidence) await page.getByRole('radio', { name: options.confidence }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
  }
  const checkFalse = async (page: Page) => {
    await page.getByRole('radio', { name: /False/ }).click()
    await page.getByRole('button', { name: 'Check answer' }).click()
  }
  const next = (page: Page) => page.getByRole('button', { name: /^(Next question|See session summary|Continue)$/ })

  /** A course with two topics and three due concepts, each with three items to draw on. */
  async function dueCourse(page: Page, label: string) {
    const user = await signUpAndIn(page, label, { own: true })
    const course = await createCourse(page, `Session ${label}`, [{ name: 'Hash tables', minutes: 30 }, { name: 'Sorting', minutes: 30 }])
    const hash = course.topics['Hash tables']
    const sort = course.topics.Sorting
    const hashing = await seedDueConcept(user.email, hash, 'Hashing', { orderIndex: 0 })
    const collisions = await seedDueConcept(user.email, hash, 'Collisions', { orderIndex: 1 })
    const quicksort = await seedDueConcept(user.email, sort, 'Quicksort', { orderIndex: 0 })
    const items = (conceptId: string, name: string) => [
      reviewItem(conceptId, `${name} statement one holds.`, 'easy'),
      reviewItem(conceptId, `${name} statement two holds.`, 'medium'),
      reviewItem(conceptId, `${name} statement three holds.`, 'easy'),
    ]
    await addQuizSet(hash, [...items(hashing, 'Hashing'), ...items(collisions, 'Collisions')])
    await addQuizSet(sort, items(quicksort, 'Quicksort'))
    return { user, course, topics: { hash, sort }, concepts: { hashing, collisions, quicksort } }
  }

  test("today's review mixes topics and writes review evidence", async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'mix')
    await page.goto(`/courses/${w.course.courseId}/review`)
    // The session is the page's main action; the topic buttons are outlined.
    const start = page.getByRole('link', { name: "Start today's review" })
    await expect(start).toHaveAttribute('href', `/courses/${w.course.courseId}/review/session`)
    await start.click()

    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })
    const topics = new Set<string>()
    for (let n = 1; n <= 3; n++) {
      await expect(page.getByRole('heading', { level: 1, name: `Question ${n} of 3` })).toBeVisible()
      topics.add((await page.locator('[data-session-context]').innerText()).split(' · ')[0].trim())
      await checkTrue(page, { confidence: n === 1 ? 'Fairly sure' : undefined })
    }
    // Every concept was right the first time: nothing to retest, so the summary follows.
    await expect(page.getByRole('heading', { level: 1, name: 'Review done' })).toBeVisible()
    await expect(page.getByText('You got 3 of 3 questions right.')).toBeVisible()
    expect(topics.size).toBe(2)

    const events = await withPrisma((prisma) =>
      prisma.evidenceEvent.findMany({ where: { user: { email: w.user.email }, sessionKey: `review:${sessionIdOf(page)}` }, orderBy: { createdAt: 'asc' } })
    )
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.source === 'review' && e.assistance === 0 && e.score === 1)).toBe(true)
    expect(new Set(events.map((e) => e.topicId))).toEqual(new Set([w.topics.hash, w.topics.sort]))
    // The confidence tap is on the evidence it belongs to, and the others are blank.
    expect(events.filter((e) => e.confidence !== null)).toHaveLength(1)
    // It is a session, not a quiz attempt (D7).
    expect(await withPrisma((prisma) => prisma.quizAttempt.count({ where: { user: { email: w.user.email } } }))).toBe(0)
    expect(await withPrisma((prisma) => prisma.itemSession.count({ where: { user: { email: w.user.email }, kind: 'review', completedAt: { not: null } } }))).toBe(1)

    // The concepts were answered, so nothing is left to bring back.
    await page.goto(`/courses/${w.course.courseId}/review`)
    await expect(page.getByRole('link', { name: "Start today's review" })).toHaveCount(0)
  })

  test('session ends with retests of misses in a fresh form', async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'retest')
    await page.goto(`/courses/${w.course.courseId}/review/session`)
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })

    const seen: string[] = []
    // Miss the first question, answer the other two right.
    await checkFalse(page)
    await expect(page.getByRole('heading', { level: 2, name: /^Not quite/ })).toBeVisible()
    seen.push(await page.getByText(/statement (one|two|three) holds\./).first().innerText())
    await next(page).click()
    for (const n of [2, 3]) {
      await expect(page.getByRole('heading', { level: 1, name: `Question ${n} of 3` })).toBeVisible()
      await checkTrue(page)
    }

    // The session did not end: the miss comes back in a different item on the same concept.
    await expect(page.getByRole('heading', { level: 1, name: 'Question 4 of 4' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Fresh retest')).toBeVisible()
    const retest = await page.getByText(/statement (one|two|three) holds\./).first().innerText()
    expect(retest).not.toBe(seen[0])
    expect(retest.split(' ')[0]).toBe(seen[0].split(' ')[0])
    await checkTrue(page)

    await expect(page.getByRole('heading', { level: 1, name: 'Review done' })).toBeVisible()
    await expect(page.getByText('You got 2 of 3 questions right, then 1 of 1 fresh retest right.')).toBeVisible()
    await expect(page.getByText('Back on track')).toBeVisible()
    const events = await withPrisma((prisma) =>
      prisma.evidenceEvent.findMany({ where: { user: { email: w.user.email }, sessionKey: { startsWith: `review:${sessionIdOf(page)}` }, source: 'review' } })
    )
    expect(events).toHaveLength(4)
    expect(events.filter((e) => e.score === 0)).toHaveLength(1)
    // The retest is its own rating (the miss is not averaged with it).
    expect(events.filter((e) => e.sessionKey.endsWith(':retest'))).toHaveLength(1)
  })

  test('no auto-advance after feedback', async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'pause')
    await page.goto(`/courses/${w.course.courseId}/review/session`)
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })
    // The page's clock is the test's from here, so "time passes" is a call, not a wait.
    await page.clock.install()
    await checkFalse(page)
    await expect(page.getByRole('heading', { level: 2, name: /^Not quite/ })).toBeVisible()
    // The feedback waits: neither time nor a key press moves on, only Next does.
    await page.clock.runFor(30_000)
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: /^Not quite/ })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: /^Not quite/ })).toBeFocused()
    await next(page).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Question 2 of 3' })).toBeVisible()
    // A reload goes on at the first question not answered, with the session kept in the address.
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Question 2 of 3' })).toBeVisible()
  })

  test('concepts with no fresh item are written by the review-item job and the session fills in', async ({ page, context }) => {
    test.setTimeout(240_000)
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'job', { own: true })
    const courseId = await createEmptyCourse(page, 'Job course')
    await addMaterial(page, courseId)
    const course = await createCourse(page, 'Job course', [{ name: 'Sorting algorithms', minutes: 30 }], { existingCourseId: courseId })
    const topicId = course.topics['Sorting algorithms']
    const merge = await seedDueConcept(user.email, topicId, 'Merge sort', { orderIndex: 0 })
    const quick = await seedDueConcept(user.email, topicId, 'Quicksort', { orderIndex: 1 })

    // Nothing to serve yet: the session asks for one job for the topic and shows the questions once it is done.
    // The second read of the session fails (the network drops once): polling must go on regardless.
    //
    // The app's own job is held before it is sent (the stack's E2E_HOLD_DIR hook, src/lib/tasks/dispatch.ts), until the two dropped
    // reads have happened. The mock AI service finishes a review-item job in well under a second, so whether the first read found
    // it still being written or already done was a race (the read count below failed about one run in six). The app creates the
    // job and builds the request; the spec reads that request from the hold and then lets it go.
    const holdDir = join(process.env.E2E_RUN_DIR || join(process.cwd(), '..', '.e2e'), 'hold')
    const gate = join(holdDir, 'generate_review_items.hold')
    await mkdir(holdDir, { recursive: true })
    await writeFile(gate, '')
    let reads = 0
    try {
      await page.route(`**/api/review-sessions/*`, async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        reads += 1
        if (reads === 2 || reads === 3) return route.abort()
        return route.continue()
      })
      await page.goto(`/courses/${courseId}/review/session`)
      // The first read says the questions are being written; the next two fail; the one after that is a read that still works.
      await expect.poll(() => reads, { timeout: 60_000 }).toBeGreaterThanOrEqual(3)
      // The job the app made is waiting to be sent, and the request it built is exactly one topic with the two concepts.
      const held = await withPrisma((prisma) => prisma.processingJob.findMany({ where: { projectId: courseId, jobType: 'generate_review_items' } }))
      expect(held).toHaveLength(1)
      expect(held[0].status).toBe('pending')
      expect(held[0].targetKey).toBe(`review-items:${topicId}`)
      const requestFile = join(holdDir, `${held[0].id}.request.json`)
      await expect.poll(() => readFile(requestFile, 'utf8').then(() => true, () => false), { timeout: 30_000 }).toBe(true)
      const request = JSON.parse(await readFile(requestFile, 'utf8')) as { endpoint: string; payload: { jobId: string; jobType: string; data: { topicId: string; requests: { conceptIds: string[]; mode: string; difficulty: string }[] } } }
      expect(request.endpoint).toBe('/jobs/generate-review-items')
      expect(request.payload.jobId).toBe(held[0].id)
      expect(request.payload.jobType).toBe('generate_review_items')
      expect(request.payload.data.topicId).toBe(topicId)
      expect(request.payload.data.requests.flatMap((r) => r.conceptIds).sort()).toEqual([merge, quick].sort())
      await writeFile(join(holdDir, `${held[0].id}.release`), '')
    } finally {
      await rm(gate, { force: true })
    }
    await expect(page.getByRole('heading', { level: 1, name: /^Question 1 of \d+$/ })).toBeVisible({ timeout: 180_000 })
    expect(reads).toBeGreaterThan(3)
    const jobs = await withPrisma((prisma) => prisma.processingJob.findMany({ where: { projectId: courseId, jobType: 'generate_review_items' } }))
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe('completed')
    const input = jobs[0].inputData as { topicId: string; requests: { conceptIds: string[] }[] }
    expect(input.topicId).toBe(topicId)
    expect(input.requests.flatMap((r) => r.conceptIds).sort()).toEqual([merge, quick].sort())

    // The items are tagged with the concepts and kept in the topic's review bank, which is not a quiz set.
    const bank = await withPrisma((prisma) => prisma.topicQuiz.findMany({ where: { topicId, kind: 'review_bank' } }))
    expect(bank).toHaveLength(1)
    const stored = bank[0].questions as { concept_ids: string[]; mode: string; difficulty: string }[]
    expect(stored.length).toBeGreaterThanOrEqual(2)
    expect(new Set(stored.map((q) => q.concept_ids[0]))).toEqual(new Set([merge, quick]))
    expect(await withPrisma((prisma) => prisma.topicQuiz.count({ where: { topicId, kind: { in: ['standard', 'retry'] } } }))).toBe(0)
    await page.goto(`/courses/${courseId}/topics/${topicId}?view=quiz`)
    await expect(page.getByRole('combobox', { name: 'Quiz set' })).toHaveCount(0)
  })

  test('concept drill includes weak prerequisite', async ({ page, context }) => {
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'drill', { own: true })
    const course = await createCourse(page, 'Drill course', [{ name: 'Hash tables', minutes: 30 }, { name: 'Joins', minutes: 30, after: 'Hash tables' }])
    const hashTopic = course.topics['Hash tables']
    const joinTopic = course.topics.Joins
    const hashing = await seedDueConcept(user.email, hashTopic, 'Hashing', { orderIndex: 0 })
    const joins = await seedDueConcept(user.email, joinTopic, 'Hash joins', { orderIndex: 0 })
    await withPrisma((prisma) =>
      prisma.conceptEdge.create({
        data: { projectId: course.courseId, sourceId: hashing, targetId: joins, type: 'prerequisite', weight: 1, confidence: 0.9, origin: 'llm', status: 'confirmed' },
      })
    )
    await addQuizSet(hashTopic, [reviewItem(hashing, 'Hashing maps keys to slots.', 'easy')])
    await addQuizSet(joinTopic, [
      reviewItem(joins, 'A hash join builds a table first.', 'easy'),
      reviewItem(joins, 'A hash join probes with the other input.', 'easy'),
      reviewItem(joins, 'A hash join suits equality conditions.', 'medium', 'composition'),
      reviewItem(joins, 'A hash join can spill to disk.', 'medium', 'composition'),
    ])

    // The entry point the map and "what comes next" link to.
    await page.goto(`/courses/${course.courseId}/review/session?concept=${joins}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 5' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Before this')).toBeVisible()
    await expect(page.locator('[data-session-context]')).toHaveText('Hash tables · Hashing')
    for (let n = 1; n <= 5; n++) {
      await expect(page.getByRole('heading', { level: 1, name: `Question ${n} of 5` })).toBeVisible()
      await checkTrue(page)
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Drill done' })).toBeVisible()
    const events = await withPrisma((prisma) => prisma.evidenceEvent.findMany({ where: { user: { email: user.email }, source: 'drill' } }))
    expect(events).toHaveLength(5)
    expect(new Set(events.map((e) => e.conceptId))).toEqual(new Set([hashing, joins]))
  })

  test('a drill that ends in misses points to what to read and offers to drill again', async ({ page, context }) => {
    test.setTimeout(120_000)
    await setZoneCookie(context)
    const w = await dueCourse(page, 'drill-end')
    await page.goto(`/courses/${w.course.courseId}/review/session?concept=${w.concepts.hashing}`)
    await expect(page.getByRole('heading', { level: 1, name: /^Question 1 of \d+$/ })).toBeVisible({ timeout: 30_000 })
    const total = Number(/of (\d+)/.exec((await page.getByRole('heading', { level: 1 }).textContent()) ?? '')?.[1])
    for (let n = 1; n <= total; n++) {
      await expect(page.getByRole('heading', { level: 1, name: `Question ${n} of ${total}` })).toBeVisible()
      await checkFalse(page)
      await expect(page.getByRole('heading', { level: 2, name: /^Not quite/ })).toBeVisible()
      await next(page).click()
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Drill done' })).toBeVisible({ timeout: 30_000 })
    // Not a dead end: what to read about comes first (the pages of the concept it came from), then the drill again, then Review.
    await expect(page.getByRole('link', { name: 'Read about Hashing' })).toHaveAttribute('href', new RegExp(`/courses/${w.course.courseId}/topics/${w.topics.hash}\\?view=read&focus=${w.concepts.hashing}`))
    await expect(page.getByRole('link', { name: 'Drill this again' })).toHaveAttribute('href', `/courses/${w.course.courseId}/review/session?concept=${w.concepts.hashing}`)
    await expect(page.getByRole('link', { name: 'Back to Review' })).toBeVisible()
  })

  test('a review with nothing missed ends on Back to Review alone', async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'review-clean')
    await page.goto(`/courses/${w.course.courseId}/review/session`)
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })
    for (let n = 1; n <= 3; n++) {
      await expect(page.getByRole('heading', { level: 1, name: `Question ${n} of 3` })).toBeVisible()
      await checkTrue(page)
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Review done' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to Review' })).toBeVisible()
    await expect(page.getByRole('link', { name: /^Go to / })).toHaveCount(0)
  })

  test('a failed check because AI is down reaches the shared status and offers to skip', async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'ai-down')
    await page.route(/\/api\/review-sessions\/[0-9a-f-]{36}\/answer$/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'AI features are paused right now. Your files and progress are safe. Try again later.', details: { code: 'LLM_CREDIT_EXHAUSTED' } } }) }))
    await page.goto(`/courses/${w.course.courseId}/review/session`)
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })
    await markAiUnavailable()
    await checkTrue(page)
    await expect(page.getByRole('status').filter({ hasText: 'AI features are paused' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible()
  })

  test('Try again after a failed read goes on with the session it made, never a second one', async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'again')
    let reads = 0
    await page.route(/\/api\/review-sessions\/[0-9a-f-]{36}$/, async (route) => {
      reads += 1
      if (reads === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something broke' }) })
      return route.continue()
    })
    await page.goto(`/courses/${w.course.courseId}/review/session`)
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })
    expect(await withPrisma((prisma) => prisma.itemSession.count({ where: { user: { email: w.user.email }, kind: 'review' } }))).toBe(1)
  })

  test('a session address that is not theirs says so and offers no Try again', async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'gone')
    await page.goto(`/courses/${w.course.courseId}/review/session?session=00000000-0000-4000-8000-000000000000`)
    await expect(page.getByRole('link', { name: 'Back to Review' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  })

  test('the session screens: no axe violations at desktop and phone width, screenshots on request', async ({ page, context }) => {
    test.setTimeout(180_000)
    await setZoneCookie(context)
    for (const [name, size] of [
      ['1440x900', { width: 1440, height: 900 }],
      ['390x844', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size)
      // Each size is its own account: sign out first (the zone cookie goes with the cookies).
      await context.clearCookies()
      await setZoneCookie(context)
      const w = await dueCourse(page, `axe-${name}`)
      await page.goto(`/courses/${w.course.courseId}/review`)
      await expect(page.getByRole('link', { name: "Start today's review" })).toBeVisible()
      await expectNoAxeViolations(page, `${name}, review page`)
      await screenshotIfAsked(page, `review-page-${name}`)

      await page.goto(`/courses/${w.course.courseId}/review/session`)
      await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })
      await expectNoAxeViolations(page, `${name}, opening question`)
      await screenshotIfAsked(page, `review-session-opening-${name}`)

      // A miss with a confidence tap: the feedback.
      await page.getByRole('radio', { name: /False/ }).click()
      await chooseConfidence(page, 'Certain')
      await page.getByRole('button', { name: 'Check answer' }).click()
      await expect(page.getByRole('heading', { level: 2, name: /^Not quite/ })).toBeVisible()
      await animationsSettled(page)
      await expectNoAxeViolations(page, `${name}, feedback after a miss`)
      await screenshotIfAsked(page, `review-session-feedback-${name}`)
      await next(page).click()
      for (const n of [2, 3]) {
        await expect(page.getByRole('heading', { level: 1, name: `Question ${n} of 3` })).toBeVisible()
        await checkTrue(page)
      }

      // The closing retest of the miss.
      await expect(page.getByText('Fresh retest')).toBeVisible({ timeout: 30_000 })
      await animationsSettled(page)
      await expectNoAxeViolations(page, `${name}, closing retest`)
      await screenshotIfAsked(page, `review-session-retest-${name}`)
      await checkTrue(page)

      await expect(page.getByRole('heading', { level: 1, name: 'Review done' })).toBeVisible()
      await expectNoAxeViolations(page, `${name}, summary`)
      await screenshotIfAsked(page, `review-session-summary-${name}`)
    }
  })

  test('when grading is unavailable a question can be skipped for now, and the answer being written survives a reload', async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'skip')
    await page.goto(`/courses/${w.course.courseId}/review/session`)
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })
    const first = await page.getByText(/statement (one|two|three) holds\./).first().innerText()

    // The draft (answer and confidence) is kept across a reload.
    await page.getByRole('radio', { name: /False/ }).click()
    // True or false: "Guessing" and "Unsure" both store 0.5, so each must come back as the one tapped.
    await chooseConfidence(page, 'Unsure')
    await page.reload()
    await expect(page.getByRole('radio', { name: /False/ })).toBeChecked()
    await expect(page.getByRole('radio', { name: 'Unsure', checked: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Guessing', checked: true })).toHaveCount(0)
    await chooseConfidence(page, 'Guessing')
    await page.reload()
    await expect(page.getByRole('radio', { name: 'Guessing', checked: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Unsure', checked: true })).toHaveCount(0)
    await chooseConfidence(page, 'Certain')
    await page.reload()
    await expect(page.getByRole('radio', { name: 'Certain', checked: true })).toBeVisible()

    // Grading is down: the check fails, and the question can be put off.
    await page.route('**/api/review-sessions/*/answer', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'This answer could not be graded right now. Your answer is still here: try again in a moment.' } }) })
    )
    await page.getByRole('button', { name: 'Check answer' }).click()
    await expect(page.getByText('This answer could not be graded right now')).toBeVisible()
    await page.getByRole('button', { name: 'Skip for now' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible()
    await expect(page.getByText(first)).toHaveCount(0)
    expect(await withPrisma((prisma) => prisma.evidenceEvent.count({ where: { user: { email: w.user.email }, source: 'review' } }))).toBe(0)

    // The skipped question comes last, and the session still ends only when it is answered.
    await page.unroute('**/api/review-sessions/*/answer')
    for (const n of [1, 2, 3]) {
      await expect(page.getByRole('heading', { level: 1, name: `Question ${n} of 3` })).toBeVisible()
      if (n === 3) await expect(page.getByText(first)).toBeVisible()
      await checkTrue(page)
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Review done' })).toBeVisible()
  })

  test('a topic with no concepts and a quiz review due is sent to the quiz review, not told nothing is due', async ({ page, context }) => {
    await setZoneCookie(context)
    const user = await signUpAndIn(page, 'legacy-session', { own: true })
    const course = await createCourse(page, 'Legacy course', [{ name: 'Sorting', minutes: 30 }])
    await makeDue(course.topics.Sorting, user.email, { mastery: 0.5 })
    await page.goto(`/courses/${course.courseId}/review/session?topic=${course.topics.Sorting}`)
    await expect(page.getByRole('heading', { name: 'This topic is reviewed with its quiz' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Nothing is due')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Review with quiz questions' })).toHaveAttribute('href', `/courses/${course.courseId}/review#review-${course.topics.Sorting}`)
  })

  test('a plan review item and the Review page open sessions filtered by topic', async ({ page, context }) => {
    await setZoneCookie(context)
    const w = await dueCourse(page, 'filter')
    await page.goto(`/courses/${w.course.courseId}/review/session?topic=${w.topics.sort}`)
    // The topic's own concept, then up to two of the most pressing others: all three here.
    await expect(page.getByRole('heading', { level: 1, name: 'Question 1 of 3' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('link', { name: 'Exit' })).toHaveAttribute('href', `/courses/${w.course.courseId}/review`)
  })

  test('starting review sessions in a loop is rate limited, with a retry hint', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'start-limit', { own: true })
    const course = await createCourse(page, 'Limit course', [{ name: 'Sorting', minutes: 30 }])
    const statuses: number[] = []
    let retryAfter: string | undefined
    for (let n = 0; n < 24; n += 1) {
      const response = await page.request.post(`/api/projects/${course.courseId}/review-sessions`, { data: {} })
      statuses.push(response.status())
      if (response.status() === 429) retryAfter = response.headers()['retry-after']
    }
    expect(statuses.slice(0, 20).every((status) => status !== 429)).toBe(true)
    expect(statuses.slice(20)).toContain(429)
    expect(Number(retryAfter)).toBeGreaterThan(0)
  })
})
