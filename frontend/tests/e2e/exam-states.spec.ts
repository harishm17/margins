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

test('the weakest topic is the one recommended first step; every row links to its topic, and a topic scored 100% is not recommended', async ({ page }) => {
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
  // The row is the link to the topic; the weakest topic's "Review" button above is the one recommended step, so rows do not repeat it.
  await expect(focus.getByRole('link', { name: 'Graph search', exact: true })).toHaveAttribute('href', `/courses/${seeded.courseId}/topics/${seeded.topics['Graph search']}`)
  await expect(page.getByRole('link', { name: 'Review Hashing' })).toHaveAttribute('href', `/courses/${seeded.courseId}/topics/${seeded.topics.Hashing}`)
  await expect(page.getByRole('link', { name: /^Review / })).toHaveCount(1)
  await expect(focus.getByRole('link', { name: /^(Study|Open|Review) / })).toHaveCount(0)
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
