import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { signIn } from './helpers/auth'
import { addContent, addFileRow, addQuizSet, createCourse, reviewItem, seedDueConcept, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'
import { DEMO_EMAIL, FIXTURE_PDF, demoIds } from './helpers/seed-demo'
import { recallWorld } from './helpers/v31-recall'
import { seedConcepts } from './helpers/v31-sessions'
import { streamedPartsArrived } from './helpers/settle'

// UX review fixes, workstream 1: bugs that lose work or break a flow (items 1, 2, 5, 6, 7 and 14 of the review).
test.use({ timezoneId: ZONE })

const demo = demoIds()
const PHONE = { width: 390, height: 844 }

// ---------------------------------------------------------------------------------------------------------- 1. unsent text

test.describe('unsent text survives a reload', () => {
  test('ask: the question is kept until the server has it', async ({ page }) => {
    await signIn(page, DEMO_EMAIL)
    const ask = `/courses/${demo.course}/ask`
    await page.goto(ask, { waitUntil: 'networkidle' })
    const box = page.getByLabel('Ask about your materials')

    // A send that never reaches the server loses nothing.
    await page.route('**/api/projects/*/chat', (route) => route.abort())
    await box.fill('Why does a hash table resize?')
    await expect(page.getByTestId('ask-draft-status')).toHaveText('Saved', { timeout: 15_000 })
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: /Try again|Retry/ }).first()).toBeVisible({ timeout: 15_000 })
    await page.unroute('**/api/projects/*/chat')
    await page.goto(ask, { waitUntil: 'networkidle' })
    await expect(page.getByLabel('Ask about your materials')).toHaveValue('Why does a hash table resize?')

    // Sent for real: the box empties, and the draft is gone for good.
    await page.getByLabel('Ask about your materials').fill(`What is hashing? ${Date.now()}`)
    await expect(page.getByTestId('ask-draft-status')).toHaveText('Saved', { timeout: 15_000 })
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[?&]thread=/, { timeout: 30_000 })
    await expect(page.locator('article', { hasText: 'Sources' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('article[aria-busy]')).toHaveCount(0)
    await page.goto(ask, { waitUntil: 'networkidle' })
    await expect(page.getByLabel('Ask about your materials')).toHaveValue('')
    const drafts = await withPrisma((prisma) => prisma.studyDraft.count({ where: { surface: 'ask', projectId: demo.course } }))
    expect(drafts).toBe(0)
  })

  test('warm-up: the answer and the confidence come back', async ({ page }) => {
    await page.setViewportSize(PHONE)
    const { topicUrl } = await recallWorld(page, 'ws1-warmup', { warmup: true, readAt: false })
    await page.goto(`${topicUrl}?view=warmup`)
    await page.getByRole('button', { name: 'Start warm-up' }).click()
    await expect(page.getByRole('heading', { name: /Warm-up question 1 of/ })).toBeVisible()
    await page.getByRole('radio', { name: /Option B for question/ }).click()
    await page.getByRole('radio', { name: 'Fairly sure' }).click()
    await expect(page.getByTestId('warmup-draft-status')).toHaveText('Saved', { timeout: 15_000 })
    await page.reload()
    await expect(page.getByRole('heading', { name: /Warm-up question 1 of/ })).toBeVisible()
    await expect(page.getByRole('radio', { name: /Option B for question/, checked: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('radio', { name: 'Fairly sure', checked: true })).toBeVisible()
  })

  test('worked examples: the prediction, the reveal and the grade come back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await setZoneCookie(page.context())
    const { email } = await signUpAndIn(page, 'ws1-examples', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Examples ${Date.now()}`, [{ name: 'Novice topic' }])
    const topicId = course.topics['Novice topic']
    const example = (title: string) => ({
      title,
      difficulty: 'medium',
      problem_statement: `Insert keys for ${title}.`,
      solution_steps: [1, 2, 3].map((n) => ({ step_number: n, description: `${title} step ${n}`, work: `Work ${title} ${n}.`, explanation: `Reason ${title} ${n}.` })),
      final_answer: `Answer ${title}.`,
      key_concepts: ['Chaining'],
    })
    await addContent(topicId, { solved_examples: [example('Alpha'), example('Beta')] })
    const url = `/courses/${course.courseId}/topics/${topicId}?view=examples`
    await page.goto(url)
    await streamedPartsArrived(page)

    const whys = page.getByRole('group', { name: 'Why this step? Write your guess' })
    await whys.nth(0).getByLabel('Your guess').fill('Because the bucket was taken.')
    await whys.nth(0).getByRole('button', { name: 'Show why' }).click()
    await page.getByRole('button', { name: 'Got it' }).click()
    await expect(page.getByRole('status').filter({ hasText: /(Saved|Noted, not counted): Got it/ })).toBeVisible()
    // A guess that was written and not yet revealed.
    await whys.first().getByLabel('Your guess').fill('Because of the load factor.')
    await expect(page.getByTestId('examples-draft-status')).toHaveText('Saved', { timeout: 15_000 })

    await page.reload()
    await streamedPartsArrived(page)
    await expect(page.getByText('Reason Alpha 1.')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('status').filter({ hasText: /(Saved|Noted, not counted): Got it/ })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Why this step? Write your guess' }).first().getByLabel('Your guess')).toHaveValue('Because of the load factor.')
  })
})

// ---------------------------------------------------------------------------------------------------------- 2. practise what was missed

test('mock exam results offer new questions on what was missed, and keep Retake exam', async ({ page }) => {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'ws1-practise', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Exam practice ${Date.now()}`, [{ name: 'Hash tables' }])
  const topicId = course.topics['Hash tables']
  const concepts = await seedConcepts(topicId, ['Hashing', 'Collisions', 'Load factor'])
  const names = Object.keys(concepts)
  // A bank with new questions for every concept: the exam's own questions are not served again.
  await addQuizSet(
    topicId,
    names.flatMap((name) => [
      reviewItem(concepts[name], `${name} statement one holds.`, 'easy'),
      reviewItem(concepts[name], `${name} statement two holds.`, 'medium'),
      reviewItem(concepts[name], `${name} statement three holds.`, 'hard'),
    ])
  )
  const questions = [
    { question_type: 'true_false', question_text: 'Exam: hashing maps keys.', correct_answer: true, points: 1, topic_id: topicId, topic_name: 'Hash tables', concept_ids: [concepts.Hashing] },
    { question_type: 'true_false', question_text: 'Exam: collisions never happen.', correct_answer: false, points: 1, topic_id: topicId, topic_name: 'Hash tables', concept_ids: [concepts.Collisions] },
    { question_type: 'true_false', question_text: 'Exam: load factor is entries over buckets.', correct_answer: true, points: 1, topic_id: topicId, topic_name: 'Hash tables', concept_ids: [concepts['Load factor']] },
    { question_type: 'true_false', question_text: 'Exam: a rehash is free.', correct_answer: false, points: 1, topic_id: topicId, topic_name: 'Hash tables', concept_ids: [concepts['Load factor']] },
  ]
  const submissionId = await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const exam = await prisma.sampleExam.create({
      data: { projectId: course.courseId, name: 'Hash tables exam', questions, durationMinutes: 30, difficultyLevel: 'medium', topicsCovered: ['Hash tables'] },
    })
    // Questions 2 and 4 were missed (concepts Collisions and Load factor).
    const graded = questions.map((_, index) => ({
      question_index: index,
      question_type: 'true_false',
      points_possible: 1,
      points_earned: index === 1 || index === 3 ? 0 : 1,
      is_correct: !(index === 1 || index === 3),
      feedback: '',
      needs_review: false,
    }))
    const submission = await prisma.examSubmission.create({
      data: {
        sampleExamId: exam.id,
        userId: user.id,
        answers: { '0': 'true', '1': 'true', '2': 'true', '3': 'true' },
        aiGrading: { graded_questions: graded, total_points: 4, earned_points: 2, overall_score: 50, needs_review: false },
        gradedAt: new Date(),
        status: 'submitted',
      },
    })
    return { examId: exam.id, id: submission.id }
  })

  await page.goto(`/courses/${course.courseId}/exams/${submissionId.examId}/results/${submissionId.id}`)
  // Two missed questions, on two ideas: two new questions. The count is on the button.
  const practise = page.getByRole('button', { name: 'Practise what you missed (2 questions)' })
  await expect(practise).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retake exam' })).toBeVisible()
  await practise.click()
  await expect(page).toHaveURL(/\/review\/session\?session=/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: /^Question 1 of 2/ })).toBeVisible({ timeout: 30_000 })
  // New questions on the ideas missed, not the exam's own.
  await expect(page.getByText(/Exam: /)).toHaveCount(0)
  await expect(page.locator('[data-session-context]')).toContainText(/Collisions|Load factor/)
})

// ---------------------------------------------------------------------------------------------------------- 5 and 6. uploads

test.describe('materials', () => {
  async function courseWithFile(page: Page, label: string) {
    const { email } = await signUpAndIn(page, label, { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const created = await page.request.post('/api/projects', { data: { name: `Materials ${Date.now()}` } })
    const courseId = (await created.json()).project.id as string
    await addFileRow(courseId, 'other.pdf')
    return courseId
  }
  const rows = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name.replace('.', '\\.')) })

  test('a file deleted right after it was uploaded stays deleted', async ({ page }) => {
    const courseId = await courseWithFile(page, 'ws1-delete')
    await page.goto(`/courses/${courseId}/materials`)
    await page.getByLabel('Choose files to upload').setInputFiles(FIXTURE_PDF)
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(1)
    await page.getByRole('button', { name: 'Actions for algorithms.pdf' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete file' }).click()
    await expect(page.getByText('File deleted')).toBeVisible()
    // Not back as a file still being checked, now or after the page refreshes itself.
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(0)
    await page.waitForTimeout(3000)
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(0)
    await expect(page.getByText('Checking the file')).toHaveCount(0)
  })

  test('a repeated file asks first: cancel, keep both, or replace', async ({ page }) => {
    const courseId = await courseWithFile(page, 'ws1-duplicate')
    await page.goto(`/courses/${courseId}/materials`)
    const input = page.getByLabel('Choose files to upload')
    await input.setInputFiles(FIXTURE_PDF)
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(1)
    await expect(rows(page, 'algorithms.pdf').getByText('Ready')).toBeVisible({ timeout: 90_000 })

    // Cancel: nothing is uploaded.
    await input.setInputFiles(FIXTURE_PDF)
    const dialog = page.getByRole('dialog', { name: 'This file is already here' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('duplicate-files')).toContainText('algorithms.pdf')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await page.waitForTimeout(1000)
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(1)

    // Keep both: a second row.
    await input.setInputFiles(FIXTURE_PDF)
    await page.getByRole('dialog', { name: 'This file is already here' }).getByRole('button', { name: 'Keep both' }).click()
    await expect(rows(page, 'algorithms.pdf')).toHaveCount(2, { timeout: 30_000 })

    // Replace: the new copy goes in and the earlier ones come out.
    await input.setInputFiles(FIXTURE_PDF)
    await page.getByRole('dialog', { name: 'This file is already here' }).getByRole('button', { name: 'Replace' }).click()
    await expect.poll(async () => rows(page, 'algorithms.pdf').count(), { timeout: 60_000 }).toBe(1)
    // A different file is never held up.
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('the list names the category the file was uploaded under', async ({ page }) => {
    const courseId = await courseWithFile(page, 'ws1-category')
    await page.request.post(`/api/projects/${courseId}/materials?category=book_chapters&filename=chapter.pdf`, {
      data: (await import('node:fs')).readFileSync(FIXTURE_PDF),
      headers: { 'content-type': 'application/pdf' },
    })
    await page.goto(`/courses/${courseId}/materials`)
    await expect(rows(page, 'chapter.pdf').getByText('Book chapters', { exact: true }).filter({ visible: true })).toBeVisible()
    await expect(rows(page, 'other.pdf').getByText('Lecture notes', { exact: true }).filter({ visible: true })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------------------------------------- 7. exam save status on a phone

test('the timed exam shows Saving, Saved and a failure with Retry on a phone', async ({ page }) => {
  await page.setViewportSize(PHONE)
  const { email } = await signUpAndIn(page, 'ws1-exam-save', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Exam save ${Date.now()}`, [{ name: 'Hash tables' }])
  const examId = await withPrisma(async (prisma) => {
    const exam = await prisma.sampleExam.create({
      data: {
        projectId: course.courseId,
        name: 'Save status exam',
        questions: [1, 2, 3].map((n) => ({ question_type: 'true_false', question_text: `Statement ${n} is true.`, correct_answer: true, points: 1 })),
        durationMinutes: 30,
        difficultyLevel: 'medium',
        topicsCovered: ['Hash tables'],
      },
    })
    return exam.id
  })
  expect((await page.request.post(`/api/exams/${examId}/attempt`)).ok()).toBeTruthy()
  await page.goto(`/courses/${course.courseId}/exams/${examId}/take`)
  const status = page.getByTestId('exam-save-status')

  await page.getByRole('radio').first().click()
  await expect(status).toHaveText('Saved', { timeout: 20_000 })
  const box = await status.boundingBox()
  expect(box, 'the status is on screen').not.toBeNull()
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width)

  // A save that fails says so, with a way to try again.
  await page.route(`**/api/exams/${examId}/attempt`, (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()))
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('radio').first().click()
  await expect(status).toContainText('Not saved', { timeout: 20_000 })
  await page.unroute(`**/api/exams/${examId}/attempt`)
  await status.getByRole('button', { name: 'Retry' }).click()
  await expect(status).toHaveText('Saved', { timeout: 20_000 })
})

// ---------------------------------------------------------------------------------------------------------- 14. "I don't know" is not "Left blank"

test('a quiz question answered "I don\'t know" shows that, not Left blank', async ({ page }) => {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'ws1-idk', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `IDK ${Date.now()}`, [{ name: 'Hash tables' }])
  const topicId = course.topics['Hash tables']
  await addContent(topicId, {
    topic_quiz: [1, 2, 3].map((n) => ({ question_type: 'true_false', question_text: `Quiz statement ${n}.`, correct_answer: true, explanation: 'It is true.', points: 1, difficulty: 'medium' })),
  })
  const response = await page.request.post(`/api/topics/${topicId}/quiz-attempts`, {
    data: { answers: { '0': { answer: '', idk: true }, '1': { answer: 'true' } } },
  })
  expect(response.ok()).toBeTruthy()
  await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=quiz`)
  await streamedPartsArrived(page)
  await page.getByRole('button', { name: 'Review' }).click()
  const items = page.locator('ol > li')
  await expect(items.filter({ hasText: 'Quiz statement 1.' }).getByText("I don't know", { exact: true })).toBeVisible({ timeout: 20_000 })
  // Question 3 was never answered: that one is blank.
  await expect(items.filter({ hasText: 'Quiz statement 3.' }).getByText('Left blank')).toBeVisible()
  await expect(items.filter({ hasText: 'Quiz statement 1.' }).getByText('Left blank')).toHaveCount(0)
})

// ---------------------------------------------------------------------------------------------------------- 3. voice: Quiz me says before Start

test.describe('voice lobby: Quiz me', () => {
  const lobby = (page: Page) => page.getByTestId('voice-lobby')

  test('a topic with no quiz says so before Start, disables Quiz me, and offers the quiz', async ({ page }) => {
    const { email } = await signUpAndIn(page, 'ws1-voice-none', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Voice none ${Date.now()}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=voice`)
    await expect(lobby(page)).toBeVisible({ timeout: 30_000 })
    const alert = page.getByTestId('voice-quiz-missing')
    await expect(alert).toContainText('Quiz me needs a quiz first')
    await expect(alert).toContainText("This topic doesn't have a quiz yet")
    await expect(alert.getByRole('link', { name: 'Write the quiz' })).toHaveAttribute('href', `/courses/${course.courseId}/topics/${topicId}?view=quiz`)
    await expect(page.getByRole('button', { name: 'Start voice practice' })).toBeDisabled()
  })

  test('a topic whose quiz is made of calculations says how many and why', async ({ page }) => {
    const { email } = await signUpAndIn(page, 'ws1-voice-math', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Voice math ${Date.now()}`, [{ name: 'Algebra' }])
    const topicId = course.topics.Algebra
    await addContent(topicId, {
      topic_quiz: [2, 3].map((n) => ({ question_type: 'numerical', question_text: `Compute ${n} + ${n}.`, correct_answer: n + n, points: 1, difficulty: 'medium' })),
    })
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=voice`)
    const alert = page.getByTestId('voice-quiz-missing')
    await expect(alert).toContainText("Quiz me can't ask these questions out loud", { timeout: 30_000 })
    await expect(alert).toContainText('2 questions')
    await expect(page.getByRole('button', { name: 'Start voice practice' })).toBeDisabled()
  })

  test('a quiz whose questions mention numbers is not treated as empty, and Quiz me can start', async ({ page }) => {
    const { email } = await signUpAndIn(page, 'ws1-voice-ready', { own: true })
    await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
    const course = await createCourse(page, `Voice ready ${Date.now()}`, [{ name: 'Hash tables' }])
    const topicId = course.topics['Hash tables']
    // The wording a real quiz has: a digit in a step, a big-O in the key, and words that merely contain "sum" or "solve".
    await addContent(topicId, {
      topic_quiz: [
        { question_type: 'true_false', question_text: 'A hash lookup is O(1) on average.', correct_answer: true, explanation: 'Averaged over 100 keys.', points: 1, difficulty: 'medium' },
        { question_type: 'true_false', question_text: 'We assume the hash spreads keys evenly, and resolve collisions by chaining.', correct_answer: true, points: 1, difficulty: 'medium' },
      ],
    })
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=voice`)
    await expect(lobby(page)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('voice-quiz-missing')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start voice practice' })).toBeEnabled({ timeout: 15_000 })
    // The server agrees: a session starts with both questions.
    const started = await page.request.post('/api/voice/session', {
      data: { projectId: course.courseId, topicId, mode: 'topic_drill', style: 'oral_quiz', language: 'en' },
    })
    expect(started.ok()).toBeTruthy()
    expect((await started.json()).questionCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------------------- 13. a review session does not call its opening items "Warm-up"

test('a review session labels no question Warm-up, and a short session says what it leaves out', async ({ page }) => {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'ws1-review-label', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Review label ${Date.now()}`, [{ name: 'Hash tables' }])
  const topicId = course.topics['Hash tables']
  const concepts = { Hashing: await seedDueConcept(email, topicId, 'Hashing', { orderIndex: 0 }), Collisions: await seedDueConcept(email, topicId, 'Collisions', { orderIndex: 1 }) }
  await addQuizSet(
    topicId,
    Object.values(concepts).flatMap((id, n) => [reviewItem(id, `Statement ${n} easy holds.`, 'easy'), reviewItem(id, `Statement ${n} medium holds.`, 'medium'), reviewItem(id, `Statement ${n} hard holds.`, 'hard')])
  )
  const started = await page.request.post(`/api/projects/${course.courseId}/review-sessions`, { data: { topicId } })
  expect(started.ok()).toBeTruthy()
  const { sessionId } = await started.json()
  await page.goto(`/courses/${course.courseId}/review/session?session=${sessionId}`)
  await expect(page.getByRole('heading', { name: /^Question 1 of/ })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Warm-up', { exact: true })).toHaveCount(0)
})

test('"Have 10 minutes?" says how many questions the session has: exact when they are all written, up to when some are not', async ({ page }) => {
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'ws1-short', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Short ${Date.now()}`, [{ name: 'Hash tables' }])
  const topicId = course.topics['Hash tables']
  const ids = [
    await seedDueConcept(email, topicId, 'Hashing', { orderIndex: 0 }),
    await seedDueConcept(email, topicId, 'Collisions', { orderIndex: 1 }),
    await seedDueConcept(email, topicId, 'Load factor', { orderIndex: 2 }),
  ]
  const item = (id: string, name: string, difficulty: 'easy' | 'medium' | 'hard') => reviewItem(id, `${name} ${difficulty} statement holds.`, difficulty)
  // Two of the three concepts have questions; the third would have to be written first.
  await addQuizSet(topicId, [0, 1].flatMap((n) => (['easy', 'medium', 'hard'] as const).map((difficulty) => item(ids[n], `Concept ${n}`, difficulty))))
  const card = page.getByTestId('short-session').filter({ visible: true })
  await page.goto(`/courses/${course.courseId}/review`)
  await expect(card).toContainText('Up to 3 reviews', { timeout: 30_000 })
  // All three have questions: the number is exact.
  await addQuizSet(topicId, (['easy', 'medium', 'hard'] as const).map((difficulty) => item(ids[2], 'Concept 2', difficulty)))
  await page.goto(`/courses/${course.courseId}/review`)
  await expect(card).toContainText(/^Have 10 minutes\?\s*3 reviews, about/, { timeout: 30_000 })
})
