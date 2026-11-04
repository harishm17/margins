import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { animationsSettled, streamedPartsArrived } from './helpers/settle'
import { expectNoAxeViolations, screenshotIfAsked } from './helpers/axe'
import { addContent, addQuizSet, createCourse, quizQuestions, signUpAndIn, ZONE } from './helpers/loop'

// The surfaces that show confidence and calibration: the quiz results, the mock exam's question
// screen with its confidence row, and the exam results. Each is opened at a desktop and a phone size
// with no axe violations; set SCREENS_DIR to keep a screenshot of every one for a look by eye.

test.use({ timezoneId: ZONE })

const SIZES = [
  ['1440x900', { width: 1440, height: 900 }],
  ['390x844', { width: 390, height: 844 }],
] as const

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

const graded = (index: number, type: string, earned: number, possible: number, extra: Record<string, unknown> = {}) => ({
  question_index: index,
  question_type: type,
  points_possible: possible,
  points_earned: earned,
  is_correct: earned >= possible * 0.7,
  feedback: earned >= possible * 0.7 ? 'Correct.' : 'Not quite: check the key idea again.',
  needs_review: false,
  ...extra,
})

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

test('the exam question screen with its confidence row: no axe violations, desktop and phone', async ({ page }) => {
  test.setTimeout(120_000)
  const { course, exam } = await seedExam(page, 'Exam taker')
  await withPrisma((prisma) =>
    prisma.examSubmission.create({
      data: {
        sampleExamId: exam.id,
        userId: exam.userId,
        answers: { '0': { answer: 'A', confidence: 0.95 } },
        status: 'in_progress',
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 30 * 60_000),
        answersSavedAt: new Date(),
      },
    })
  )
  for (const [name, size] of SIZES) {
    await page.setViewportSize(size)
    // The exam resumes where the student left it (the question is kept in the tab's storage); every size starts from the first.
    await page.goto(`/courses/${course.courseId}/exams/${exam.id}/take`)
    await page.evaluate(() => window.sessionStorage.clear())
    await page.reload()
    await expect(page.getByRole('heading', { name: /Question 1 of/ })).toBeVisible()
    await animationsSettled(page)
    await expect(page.getByRole('radio', { name: 'Certain', checked: true })).toBeVisible()
    await expectNoAxeViolations(page, `exam taker, ${name}`)
    await screenshotIfAsked(page, `exam-taker-${name}`)
    // A question with no confidence yet asks for one; a short answer has the row too.
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Question 2 of/ })).toBeVisible()
    await expect(page.getByText('How sure are you?')).toBeVisible()
    // The question slides in; colours are read once it has settled.
    await animationsSettled(page)
    await expectNoAxeViolations(page, `exam taker, unanswered confidence, ${name}`)
    await screenshotIfAsked(page, `exam-taker-unrated-${name}`)
  }
})

test('the exam results with its calibration line and sure-and-wrong group: no axe violations, desktop and phone', async ({ page }) => {
  test.setTimeout(120_000)
  const { course, exam } = await seedExam(page, 'Exam results')
  const submissionId = randomUUID()
  const answers = {
    '0': { answer: 'B', confidence: 0.95 },
    '1': { answer: 'B', confidence: 0.75 },
    '2': { answer: 'true', confidence: 0.5 },
    '3': { answer: 'You skip nodes you have seen.', confidence: 0.25 },
  }
  const questions = [
    graded(0, 'multiple_choice', 0, 2),
    graded(1, 'multiple_choice', 2, 2),
    graded(2, 'true_false', 1, 1),
    graded(3, 'short_answer', 2, 3, { criteria: [] }),
  ]
  await withPrisma((prisma) =>
    prisma.examSubmission.create({
      data: {
        id: submissionId,
        sampleExamId: exam.id,
        userId: exam.userId,
        answers,
        aiGrading: {
          total_points: 8,
          earned_points: 5,
          overall_score: 62.5,
          submission_id: submissionId,
          graded_questions: questions,
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
  for (const [name, size] of SIZES) {
    await page.setViewportSize(size)
    await page.goto(`/courses/${course.courseId}/exams/${exam.id}/results/${submissionId}`)
    await streamedPartsArrived(page)
    await expect(page.getByRole('heading', { name: 'Where to focus' })).toBeVisible()
    await expect(page.getByText(/You were sure about 2 answers and got 1 of them right\./)).toBeVisible()
    // One topic only: its row says where to study and does not repeat the exam's score, which the ring has.
    const focus = page.locator('section[aria-labelledby="where-to-focus"]')
    await expect(focus).toContainText('Graph search')
    await expect(focus).not.toContainText('62.5%')
    await expect(focus).not.toContainText('Weakest first')
    // The one recommended first step is above, once; the focus row only opens the topic.
    await expect(page.getByRole('link', { name: 'Review Graph search' })).toHaveCount(1)
    await expect(focus.getByRole('link', { name: 'Graph search' })).toBeVisible()
    await expect(page.getByText('Other ways to study')).toBeVisible()
    await expectNoAxeViolations(page, `exam results, ${name}`)
    await screenshotIfAsked(page, `exam-results-${name}`)
    await page.getByRole('radio', { name: /^Missed/ }).click()
    await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
    // "Missed 2" is two questions (one wrong, one only partly right), each a labelled row; Expand all opens their reviews,
    // each with its points spelled out. The first miss to read starts open and the rest collapsed.
    await expect(page.getByRole('radio', { name: 'Missed 2' })).toBeChecked()
    const rows = page.locator('section[aria-labelledby="exam-questions-review"]')
    await expect(rows.locator('button[aria-expanded]')).toHaveCount(2)
    await expect(rows.locator('button[aria-expanded="true"]')).toHaveCount(1)
    await page.getByRole('button', { name: 'Expand all' }).click()
    await expect(page.getByText('0 of 2 pts')).toBeVisible()
    await expect(page.getByText('2 of 3 pts')).toBeVisible()
    await expect(page.getByText('2 of 2 pts')).toHaveCount(0)
    await expectNoAxeViolations(page, `exam results, missed, ${name}`)
    await screenshotIfAsked(page, `exam-results-missed-${name}`)
  }
})

test('the quiz results with the confidence it was answered with: no axe violations, desktop and phone', async ({ page }) => {
  test.setTimeout(180_000)
  await signUpAndIn(page, 'results-surfaces', { own: true })
  const course = await createCourse(page, `Quiz results ${stamp}`, [{ name: 'Graph search' }])
  const topicId = course.topics['Graph search']
  await addContent(topicId, { section_notes: '# Graph search\n\nNotes.' })

  for (const [name, size] of SIZES) {
    await page.setViewportSize(size)
    // The same questions open again only tomorrow (spec 7.3), so each size takes a set of its own (the newest opens first).
    await addQuizSet(topicId, quizQuestions(3))
    await page.goto(`/courses/${course.courseId}/topics/${topicId}?view=quiz`)
    await page.getByRole('button', { name: 'Start quiz' }).click()
    await expect(page.getByText('Question 1 of')).toBeVisible()
    await expectNoAxeViolations(page, `quiz question, ${name}`)
    await screenshotIfAsked(page, `quiz-question-${name}`)
    // Question 1 wrong and certain; question 2 right and unsure; question 3 left blank.
    await page.getByRole('radio', { name: 'False' }).click()
    await page.getByRole('radio', { name: 'Certain' }).click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByText('Question 2 of')).toBeVisible()
    await page.getByRole('radio', { name: 'True' }).click()
    await page.getByRole('radio', { name: 'Unsure' }).click()
    // True or false: "Unsure" stores the same 0.5 as "Guessing", and still comes back as "Unsure" after a reload.
    await page.reload()
    await expect(page.getByText('Question 2 of')).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Unsure', checked: true })).toBeVisible()
    if (size.width < 640) {
      // One navigator on a phone: the Questions button and its sheet.
      await page.getByRole('button', { name: 'Questions', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: /^Question 3/ }).click()
    } else {
      await page.getByRole('button', { name: /^Question 3/ }).first().click()
    }
    await page.getByRole('button', { name: 'Submit quiz' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Submit quiz' }).click()

    await expect(page.getByRole('heading', { name: /points/ })).toBeVisible({ timeout: 60_000 })
    await expectNoAxeViolations(page, `quiz results, ${name}`)
    await screenshotIfAsked(page, `quiz-results-${name}`)
    // On a phone the question-by-question review is one button away, so the score and the next step come first.
    if (size.width < 640) await page.getByRole('button', { name: /Review the questions/ }).click()
    await page.getByRole('radio', { name: /Missed/ }).click()
    await expectNoAxeViolations(page, `quiz results, missed, ${name}`)
    await screenshotIfAsked(page, `quiz-results-missed-${name}`)
  }
})

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
