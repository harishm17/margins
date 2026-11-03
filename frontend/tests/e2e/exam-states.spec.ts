import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { createCourse, signUpAndIn, ZONE } from './helpers/loop'

// The exam surfaces around the edges of a result: a 0% and a 100% result, a blank answer, exams told apart by
// the topics they cover, and the cue that a mock exam is in progress. Set SCREENS_DIR to keep screenshots.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const questions = (topicId: string, topicName: string) => [
  {
    question_type: 'multiple_choice',
    question_text: 'Which structure does breadth-first search use?',
    options: [
      { id: 'A', text: 'A queue' },
      { id: 'B', text: 'A stack' },
    ],
    correct_answer: 'A',
    explanation: 'It visits nodes in the order they were found.',
    points: 2,
    topic_id: topicId,
    topic_name: topicName,
  },
  {
    question_type: 'short_answer',
    question_text: 'Why does a visited set keep a graph search from looping?',
    sample_answer: 'A node already seen is skipped.',
    key_points: ['Seen nodes are skipped'],
    explanation: 'Without it a cycle would be followed forever.',
    points: 2,
    topic_id: topicId,
    topic_name: topicName,
  },
]

type Seeded = { userId: string; courseId: string; topics: Record<string, string> }

async function seed(page: Page, label: string, topicNames: string[] = ['Graph search']): Promise<Seeded> {
  const { email } = await signUpAndIn(page, label, { own: true })
  const course = await createCourse(page, `${label} ${Date.now()}`, topicNames.map((name) => ({ name })))
  const userId = await withPrisma(async (prisma) => (await prisma.user.findFirstOrThrow({ where: { email } })).id)
  return { userId, courseId: course.courseId, topics: course.topics }
}

async function makeExam(seeded: Seeded, topicName: string, createdAt?: Date) {
  return withPrisma((prisma) =>
    prisma.sampleExam.create({
      data: {
        projectId: seeded.courseId,
        name: 'Sample Exam - 2026-11-20',
        durationMinutes: 30,
        difficultyLevel: 'medium',
        topicsCovered: [topicName],
        questions: questions(seeded.topics[topicName], topicName),
        ...(createdAt ? { createdAt } : {}),
      },
      select: { id: true },
    })
  )
}

/** A submitted attempt. `earned` is the points for each question, in order; `answers` is what the student gave (blank when absent). */
async function submit(seeded: Seeded, examId: string, earned: [number, number], answers: Record<string, unknown>) {
  const id = randomUUID()
  const total = 4
  const got = earned[0] + earned[1]
  await withPrisma((prisma) =>
    prisma.examSubmission.create({
      data: {
        id,
        sampleExamId: examId,
        userId: seeded.userId,
        answers: answers as object,
        aiGrading: {
          total_points: total,
          earned_points: got,
          overall_score: (got / total) * 100,
          submission_id: id,
          graded_questions: [
            { question_index: 0, question_type: 'multiple_choice', points_possible: 2, points_earned: earned[0], is_correct: earned[0] >= 2, feedback: earned[0] >= 2 ? 'Correct.' : 'Not quite.', needs_review: false },
            { question_index: 1, question_type: 'short_answer', points_possible: 2, points_earned: earned[1], is_correct: earned[1] >= 2, feedback: earned[1] >= 2 ? 'Correct.' : 'Not quite.', needs_review: false, criteria: [] },
          ],
        },
        submittedAt: new Date(Date.now() - 3600_000),
        gradedAt: new Date(),
        status: 'submitted',
        startedAt: new Date(Date.now() - 2 * 3600_000),
        deadlineAt: new Date(Date.now() - 3600_000),
        answersSavedAt: new Date(),
      },
    })
  )
  return id
}

test('a 0% exam result is a small calm ring, a blank answer has no "Explain this mistake", and a wrong one does', async ({ page }) => {
  const seeded = await seed(page, 'exam-zero')
  const exam = await makeExam(seeded, 'Graph search')
  // The first question is answered wrongly; the second is left blank.
  const submissionId = await submit(seeded, exam.id, [0, 0], { '0': { answer: 'B', confidence: 0.5 } })
  for (const [name, size] of [['1440x900', DESKTOP], ['390x844', PHONE]] as const) {
    await page.setViewportSize(size)
    await page.goto(`/courses/${seeded.courseId}/exams/${exam.id}/results/${submissionId}`)
    const score = page.getByRole('region', { name: 'Your score' })
    await expect(score).toBeVisible()
    const ring = score.getByRole('img', { name: 'Score 0%' })
    await expect(ring).toBeVisible()
    // Not the big 96px ring of a real score: the small one, with the headline in the smaller size.
    const box = await ring.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(48)
    await expect(score.getByText('0 of 4 points')).toBeVisible()
    // One wrong answer gets the link; the blank one does not.
    await expect(page.getByRole('link', { name: 'Explain this mistake' })).toHaveCount(1)
    const items = page.locator('ol > li').filter({ hasText: /Which structure|Why does a visited set/ })
    await expect(items.filter({ hasText: 'Why does a visited set' }).getByRole('link', { name: 'Explain this mistake' })).toHaveCount(0)
    await expect(items.filter({ hasText: 'Which structure' }).getByRole('link', { name: 'Explain this mistake' })).toHaveCount(1)
    await screenshotIfAsked(page, `final-exam-zero-${name}`)
    await expectNoAxeViolations(page, `exam result at 0%, ${name}`)
  }
})

test('a topic scored 100% offers "Open", not "Study"', async ({ page }) => {
  const seeded = await seed(page, 'exam-full', ['Graph search', 'Hashing'])
  // Both topics' questions in one exam: full marks on the first topic's, none on the second's.
  const exam = await withPrisma((prisma) =>
    prisma.sampleExam.create({
      data: {
        projectId: seeded.courseId,
        name: 'Sample Exam - 2026-11-20',
        durationMinutes: 30,
        difficultyLevel: 'medium',
        topicsCovered: ['Graph search', 'Hashing'],
        questions: [questions(seeded.topics['Graph search'], 'Graph search')[0], questions(seeded.topics.Hashing, 'Hashing')[0]],
      },
      select: { id: true },
    })
  )
  const id = randomUUID()
  await withPrisma((prisma) =>
    prisma.examSubmission.create({
      data: {
        id,
        sampleExamId: exam.id,
        userId: seeded.userId,
        answers: { '0': { answer: 'A', confidence: 0.95 }, '1': { answer: 'B', confidence: 0.5 } },
        aiGrading: {
          total_points: 4,
          earned_points: 2,
          overall_score: 50,
          submission_id: id,
          graded_questions: [
            { question_index: 0, question_type: 'multiple_choice', points_possible: 2, points_earned: 2, is_correct: true, feedback: 'Correct.', needs_review: false },
            { question_index: 1, question_type: 'multiple_choice', points_possible: 2, points_earned: 0, is_correct: false, feedback: 'Not quite.', needs_review: false },
          ],
        },
        submittedAt: new Date(Date.now() - 3600_000),
        gradedAt: new Date(),
        status: 'submitted',
        startedAt: new Date(Date.now() - 2 * 3600_000),
        deadlineAt: new Date(Date.now() - 3600_000),
        answersSavedAt: new Date(),
      },
    })
  )
  await page.goto(`/courses/${seeded.courseId}/exams/${exam.id}/results/${id}`)
  const focus = page.locator('section[aria-labelledby="where-to-focus"]')
  await expect(focus.getByRole('link', { name: 'Open Graph search' })).toHaveAttribute('href', `/courses/${seeded.courseId}/topics/${seeded.topics['Graph search']}`)
  await expect(focus.getByRole('link', { name: 'Open Graph search' })).toHaveText('Open')
  await expect(focus.getByRole('link', { name: 'Study Hashing' })).toHaveText('Study')
  await expect(focus.getByRole('link', { name: 'Study Graph search' })).toHaveCount(0)
})

test('exams made on one day are told apart by the topics they cover', async ({ page }) => {
  const seeded = await seed(page, 'exam-titles', ['Graph search', 'Hashing'])
  const first = await makeExam(seeded, 'Graph search', new Date(Date.now() - 2 * 60_000))
  const second = await makeExam(seeded, 'Hashing', new Date(Date.now() - 60_000))
  await page.goto(`/courses/${seeded.courseId}/exams`)
  await expect(page.getByText(/^Mock exam, [A-Z][a-z]{2} \d{1,2}: Graph search$/)).toBeVisible()
  await expect(page.getByText(/^Mock exam, [A-Z][a-z]{2} \d{1,2}: Hashing$/)).toBeVisible()
  await screenshotIfAsked(page, 'final-exam-titles-1440x900')
  // The same title is on the lobby and the results of each.
  await page.goto(`/courses/${seeded.courseId}/exams/${second.id}`)
  await expect(page.getByRole('heading', { name: /Mock exam, [A-Z][a-z]{2} \d{1,2}: Hashing/ }).first()).toBeVisible()
  expect(first.id).not.toBe(second.id)
})

test('a mock exam in progress is shown on the other course pages, with the way back, and only while it is in progress', async ({ page }) => {
  const seeded = await seed(page, 'exam-cue')
  const exam = await makeExam(seeded, 'Graph search')
  const attempt = await withPrisma((prisma) =>
    prisma.examSubmission.create({
      data: {
        sampleExamId: exam.id,
        userId: seeded.userId,
        answers: {},
        status: 'in_progress',
        startedAt: new Date(Date.now() - 60_000),
        deadlineAt: new Date(Date.now() + 25 * 60_000),
      },
      select: { id: true },
    })
  )
  const cue = page.getByRole('complementary', { name: 'Mock exam in progress' })
  for (const [name, size] of [['1440x900', DESKTOP], ['390x844', PHONE]] as const) {
    await page.setViewportSize(size)
    for (const path of ['', '/plan', '/topics', '/ask']) {
      await page.goto(`/courses/${seeded.courseId}${path}`)
      await expect(cue, `the cue on ${path || 'the overview'}`).toBeVisible()
      await expect(cue.getByRole('link', { name: 'Back to your mock exam' })).toHaveAttribute('href', `/courses/${seeded.courseId}/exams/${exam.id}/take`)
    }
    await page.goto(`/courses/${seeded.courseId}/exams`)
    await screenshotIfAsked(page, `final-exam-cue-${name}`)
    await expectNoAxeViolations(page, `exam in progress cue, ${name}`)
  }
  // The Ask page fills the screen: the cue does not push its bottom edge out of view.
  await page.setViewportSize(DESKTOP)
  await page.goto(`/courses/${seeded.courseId}/ask`)
  await expect(cue).toBeVisible()
  const cueBox = await cue.boundingBox()
  expect(cueBox!.height).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1)

  // The link goes to the exam, which has no cue of its own.
  await cue.getByRole('link', { name: 'Back to your mock exam' }).click()
  await expect(page).toHaveURL(new RegExp(`/exams/${exam.id}/take$`))
  await expect(cue).toHaveCount(0)

  // Submitted: the cue is gone. A timed attempt whose time ran out while away is not in progress either.
  await withPrisma((prisma) => prisma.examSubmission.update({ where: { id: attempt.id }, data: { status: 'submitted', submittedAt: new Date() } }))
  await page.goto(`/courses/${seeded.courseId}/plan`)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await expect(cue).toHaveCount(0)
  await withPrisma((prisma) => prisma.examSubmission.update({ where: { id: attempt.id }, data: { status: 'in_progress', deadlineAt: new Date(Date.now() - 60_000) } }))
  await page.goto(`/courses/${seeded.courseId}/plan`)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await expect(cue).toHaveCount(0)
})
