import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import {
  ZONE,
  addContent,
  addMaterial,
  createCourse,
  createEmptyCourse,
  dayIn,
  makeDue,
  practiceProblem,
  quizQuestions,
  setZoneCookie,
  signIn,
  signUpAndIn,
} from './helpers/loop'

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
    await expect(page.getByText(/The next 14 days, planned for 45 minutes a day/).locator('visible=true')).toBeVisible()

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
    await expect(today.getByRole('link', { name: 'Learn Sorting', exact: true })).toHaveAttribute(
      'href',
      `/courses/${course.courseId}/topics/${course.topics.Sorting}`
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
    await expect(upNext).toContainText('Learn Sorting')
    await expect(upNext.getByRole('link', { name: 'See the plan' })).toHaveAttribute('href', `/courses/${course.courseId}/plan`)
    const card = page.getByRole('region', { name: 'When is your exam?' })
    await expect(card).toBeVisible()

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
    await page.getByRole('region', { name: 'When is your exam?' }).getByRole('button', { name: 'Not now' }).click()
    await expect(page.getByRole('region', { name: 'When is your exam?' })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('region', { name: 'When is your exam?' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Up next' })).toBeVisible()
  })

  test('the exam date and the daily time can be set when the course is created', async ({ page, context }) => {
    await setZoneCookie(context)
    await signUpAndIn(page, 'create')
    await page.goto('/courses/new')
    await page.getByLabel('Course name').locator('visible=true').fill('Dated course')
    await page.getByLabel('Exam date').locator('visible=true').fill(dayIn(ZONE, 40))
    await page.getByRole('combobox', { name: 'Time to study each day' }).click()
    await page.getByRole('option', { name: '1 hour 30 minutes' }).click()
    await page.getByRole('button', { name: 'Create course' }).click()
    await expect(page).toHaveURL(/\/courses\/[0-9a-f-]{36}$/)
    const courseId = page.url().split('/').pop() as string
    const row = await withPrisma((prisma) => prisma.project.findUniqueOrThrow({ where: { id: courseId } }))
    expect(row.examDate?.toISOString().slice(0, 10)).toBe(dayIn(ZONE, 40))
    expect(row.dailyMinutes).toBe(90)

    await page.goto(`/courses/${courseId}/settings`)
    await expect(page.getByLabel('Exam date').locator('visible=true')).toHaveValue(dayIn(ZONE, 40))
    await expect(page.getByRole('combobox', { name: 'Time to study each day' })).toContainText('1 hour 30 minutes')
  })
})

test.describe('practice progress', () => {
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
    // It resumes at the second step, takes a hint, finishes.
    await phone.getByRole('button', { name: 'Hint' }).click()
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
      page.getByRole('navigation', { name: 'Study path' }).getByRole('link', { name: /Practice/ }).getByRole('img', { name: 'Completed' })
    ).toBeVisible()

    // Starting over is stored too.
    await page.getByRole('button', { name: 'Start over' }).click()
    await expect(page.getByText('0 of 2 solved').locator('visible=true')).toBeVisible()
    await expect
      .poll(async () => (await (await page.request.get(`/api/topics/${course.topics.Squares}/practice-progress`)).json()).problems[0]?.solvedSteps)
      .toEqual([])
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
    await expect(card.getByRole('button', { name: 'Retry what you missed for Graph traversal' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'New questions for Graph traversal' })).toBeVisible()
    await expect(page.locator(`#review-${course.topics['Sorting algorithms']}`)).toHaveCount(0)

    // New questions: a new 6-question set, focused on the concepts that were missed, with a question
    // or two from the prerequisite topic. It is written by the regeneration path.
    await card.getByRole('button', { name: 'New questions for Graph traversal' }).click()
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
    await expect(again.getByRole('button', { name: 'New questions for Graph traversal' })).toBeVisible()

    // The retry is also offered on the topic's own quiz page while it is due.
    await page.goto(`/courses/${courseId}/topics/${graph}?view=quiz`)
    await expect(page.getByRole('heading', { name: 'Due for review' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New questions' })).toBeVisible()
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
    await page.goto(`/courses/${course.courseId}/topics/${strong}?view=notes`)
    await expect(page.getByText(/Strong\s+(99|100)%/).locator('visible=true').first()).toBeVisible()
    await page.goto(`/courses/${course.courseId}/topics/${weak}?view=notes`)
    await expect(page.getByText(/Learning\s+0%/).locator('visible=true').first()).toBeVisible()
    void user
  })
})
