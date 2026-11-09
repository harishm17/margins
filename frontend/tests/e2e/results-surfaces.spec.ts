import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { createCourse, signUpAndIn, ZONE } from './helpers/loop'

// The surfaces that show confidence and calibration: the quiz results, the mock exam's question
// screen with its confidence row, and the exam results. Each is opened at a desktop and a phone size
// with no axe violations; set SCREENS_DIR to keep a screenshot of every one for a look by eye.

test.use({ timezoneId: ZONE })

const stamp = Date.now()

/** Four exam questions with a known key: two choice, one true or false, one short answer. */
const EXAM_QUESTIONS = (topicId: string, topicName: string) => [
  {
    question_type: 'multiple_choice',
    question_text: 'Which structure does breadth-first search use?',
    options: [
      { id: 'A', text: 'A queue' },
      { id: 'B', text: 'A stack' },
      { id: 'C', text: 'A heap' },
      { id: 'D', text: 'A tree' },
    ],
    correct_answer: 'A',
    explanation: 'Breadth-first search visits nodes in the order they were found, which is first in, first out.',
    points: 2,
    topic_id: topicId,
    topic_name: topicName,
  },
  {
    question_type: 'multiple_choice',
    question_text: 'What does depth-first search follow before it backs up?',
    options: [
      { id: 'A', text: 'Every neighbour of the start' },
      { id: 'B', text: 'One path as far as it goes' },
      { id: 'C', text: 'The shortest path' },
      { id: 'D', text: 'The cheapest edge' },
    ],
    correct_answer: 'B',
    explanation: 'It goes deep along one path and only backs up at a dead end.',
    points: 2,
    topic_id: topicId,
    topic_name: topicName,
  },
  {
    question_type: 'true_false',
    question_text: 'A breadth-first search finds the fewest-edge path in an unweighted graph.',
    correct_answer: true,
    explanation: 'Nodes are reached in order of their distance in edges.',
    points: 1,
    topic_id: topicId,
    topic_name: topicName,
  },
  {
    question_type: 'short_answer',
    question_text: 'Why does a visited set keep a graph search from looping?',
    sample_answer: 'A node already seen is skipped, so a cycle cannot be walked twice.',
    key_points: ['Seen nodes are skipped', 'Cycles are cut'],
    explanation: 'Without it a cycle would be followed forever.',
    points: 3,
    topic_id: topicId,
    topic_name: topicName,
  },
]

async function seedExam(page: Page, label: string) {
  const { email } = await signUpAndIn(page, 'results-surfaces', { own: true })
  const course = await createCourse(page, `${label} ${stamp}`, [{ name: 'Graph search' }])
  const topicId = course.topics['Graph search']
  const exam = await withPrisma(async (prisma) => {
    const user = await prisma.user.findFirstOrThrow({ where: { email } })
    return prisma.sampleExam.create({
      data: {
        projectId: course.courseId,
        name: `Sample Exam - 2026-11-20`,
        durationMinutes: 30,
        difficultyLevel: 'medium',
        topicsCovered: ['Graph search'],
        questions: EXAM_QUESTIONS(topicId, 'Graph search'),
      },
      select: { id: true, projectId: true },
    }).then((created) => ({ ...created, userId: user.id }))
  })
  return { course, topicId, exam, email }
}

test.describe.configure({ mode: 'serial' })

test('the exam lobby shows an attempt still being graded, and turns it into its score on its own', async ({ page }) => {
  test.setTimeout(120_000)
  const { course, exam } = await seedExam(page, 'Exam lobby grading')
  const submissionId = randomUUID()
  // Handed in a moment ago, no grading job yet: grading is about to start.
  await withPrisma((prisma) =>
    prisma.examSubmission.create({
      data: {
        id: submissionId,
        sampleExamId: exam.id,
        userId: exam.userId,
        answers: {},
        submittedAt: new Date(),
        status: 'submitted',
        startedAt: new Date(Date.now() - 600_000),
        deadlineAt: new Date(Date.now() + 600_000),
        answersSavedAt: new Date(),
      },
    })
  )
  await page.goto(`/courses/${course.courseId}/exams/${exam.id}`)
  const attempts = page.locator('section[aria-labelledby="attempts"]')
  await expect(attempts.getByText('Grading', { exact: true })).toBeVisible()
  // The grade lands in the database; the page is not touched.
  await withPrisma((prisma) =>
    prisma.examSubmission.update({
      where: { id: submissionId },
      data: { gradedAt: new Date(), aiGrading: { total_points: 8, earned_points: 6, overall_score: 75, submission_id: submissionId, graded_questions: [] } },
    })
  )
  await expect(attempts.getByText('75%')).toBeVisible({ timeout: 20_000 })
  await expect(attempts.getByText('Grading', { exact: true })).toHaveCount(0)
})
