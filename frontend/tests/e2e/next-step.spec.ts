import { expect, test } from '@playwright/test'
import { expectNoAxeViolations } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addContent, createCourse, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// One next step everywhere: the topic path, Home, the plan, the Topics list and the topic's own line agree, the
// extras wait for a first quiz or recall, and the topic's next-step line stays quiet on a step the student chose.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }

async function seed(email: string, topicId: string, options: { warmup?: boolean; readAt?: boolean; quizScore?: number } = {}) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    await prisma.concept.create({ data: { projectId: topic.projectId, topicId, name: 'Hashing', summary: 'Hashing.', kind: 'concept', orderIndex: 0, objectiveIndexes: [] } })
    await prisma.topic.update({ where: { id: topicId }, data: { evidenceBackfilledAt: new Date() } })
    if (options.warmup) await prisma.topicQuiz.create({ data: { topicId, kind: 'warmup', questions: quizQuestions(5) } })
    const data = { ...(options.readAt ? { readAt: new Date(Date.now() - 3_600_000) } : {}), ...(options.quizScore !== undefined ? { quizScore: options.quizScore } : {}) }
    if (Object.keys(data).length > 0) {
      await prisma.topicProgress.upsert({ where: { topicId_userId: { topicId, userId: user.id } }, create: { topicId, userId: user.id, ...data }, update: data })
    }
  })
}

test('the 10-minute check and voice practice wait for a first quiz or recall, and say what opens them', async ({ page }) => {
  test.setTimeout(120_000)
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'ns-locked', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Locked ${Date.now()}`, [{ name: 'Hash tables' }])
  const topic = course.topics['Hash tables']
  await addContent(topic, { section_notes: '# Notes\n\nSome notes.', topic_quiz: quizQuestions(3) })
  await seed(email, topic, { warmup: true })
  await page.setViewportSize(DESKTOP)

  await page.goto('/home')
  await expect(page.getByTestId('short-session-locked').locator('visible=true')).toHaveText('A 10-minute check opens after your first quiz or recall.')
  await expect(page.getByTestId('short-session')).toHaveCount(0)

  await page.goto(`/courses/${course.courseId}/review`)
  await expect(page.getByTestId('review-extras-locked').locator('visible=true')).toHaveText('The 10-minute check and voice practice open after your first quiz or recall.')
  await expect(page.getByTestId('short-session')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Start voice practice' })).toHaveCount(0)
  await expectNoAxeViolations(page, 'review with the extras locked')

  // A first quiz opens them.
  await seed2(email, topic)
  await page.goto(`/courses/${course.courseId}/review`)
  await expect(page.getByTestId('review-extras-locked')).toHaveCount(0)
})

/** A quiz score on the topic: the student has taken a first quiz. */
async function seed2(email: string, topicId: string) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
    await prisma.topicProgress.upsert({ where: { topicId_userId: { topicId, userId: user.id } }, create: { topicId, userId: user.id, quizScore: 80, quizCompleted: true }, update: { quizScore: 80, quizCompleted: true } })
  })
}

test('the Topics list names the same five steps and the same next step as the topic', async ({ page }) => {
  test.setTimeout(120_000)
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'ns-list', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `List ${Date.now()}`, [{ name: 'Hash tables' }])
  const topic = course.topics['Hash tables']
  await addContent(topic, { section_notes: '# Notes\n\nSome notes.', topic_quiz: quizQuestions(3) })
  await seed(email, topic, { warmup: true })
  await page.setViewportSize(DESKTOP)
  await page.goto(`/courses/${course.courseId}/topics`)
  const row = page.getByRole('link', { name: /^Hash tables/ })
  await expect(row).toHaveAccessibleName(/Next: Warm-up/)
  await expect(row).not.toHaveAccessibleName(/Notes|Worked examples/)
  // The row says what is next and where the topic stands, in words; the steps done are in its details. No strip of icons.
  await expect(row).toContainText('Next: Warm-up')
  await page.getByRole('button', { name: 'Show details: Hash tables' }).click()
  await expect(page.getByText(/0 of \d steps done/).first()).toBeVisible()
  await expect(row.locator('[role="img"]')).toHaveCount(0)
  await expectNoAxeViolations(page, 'topics list')
  // The topic opens on the step the row named.
  await page.goto(`/courses/${course.courseId}/topics/${topic}`)
  await expect(page).toHaveURL(/view=warmup/)
})
