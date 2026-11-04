import { expect, test, type Page } from '@playwright/test'
import { expectNoAxeViolations } from './helpers/axe'
import { withPrisma } from './helpers/db'
import { addContent, createCourse, quizQuestions, setZoneCookie, signUpAndIn, ZONE } from './helpers/loop'

// One next step everywhere: the topic path, Home, the plan, the Topics list and the topic's own line agree, the
// extras wait for a first quiz or recall, and the topic's next-step line stays quiet on a step the student chose.

test.use({ timezoneId: ZONE })

const DESKTOP = { width: 1440, height: 900 }
const line = (page: Page) => page.getByRole('region', { name: 'Next on this topic' })

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

test('a topic nobody has opened is linked by its bare address, and no page calls the reading notes', async ({ page }) => {
  test.setTimeout(120_000)
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'ns-unopened', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Unopened ${Date.now()}`, [{ name: 'Hash tables' }, { name: 'Sorting' }])
  // One topic has written content (so the course is past setup); the other has never been opened.
  await addContent(course.topics.Sorting, { section_notes: '# Notes\n\nSome notes.' })
  await page.setViewportSize(DESKTOP)
  await page.goto(`/courses/${course.courseId}/plan`)
  const bare = `/courses/${course.courseId}/topics/${course.topics['Hash tables']}`
  const row = page.getByRole('main').getByRole('listitem').filter({ has: page.locator(`a[href="${bare}"]`) }).last()
  await expect(row.getByRole('link', { name: /^Open the topic/ })).toHaveAttribute('href', bare)
  await expect(row).toContainText('Margins gets this topic ready when you open it, then starts you on its first step.')
  await expect(page.getByText(/read the notes|Start with the notes/i)).toHaveCount(0)
  // The bare address opens on the reader (the topic is prepared as it opens); the line says nothing yet.
  await page.goto(bare)
  await expect(page).toHaveURL(/view=read/)
  await expect(line(page)).toHaveCount(0)
})

test('the next-step line is quiet: absent on an unfinished step the student chose, a link on a finished one', async ({ page }) => {
  test.setTimeout(120_000)
  await setZoneCookie(page.context())
  const { email } = await signUpAndIn(page, 'ns-line', { own: true })
  await withPrisma((prisma) => prisma.user.update({ where: { email }, data: { seenEffortIntroAt: new Date() } }))
  const course = await createCourse(page, `Line ${Date.now()}`, [{ name: 'Hash tables' }])
  const topic = course.topics['Hash tables']
  await addContent(topic, { section_notes: '# Notes\n\nSome notes.', topic_quiz: quizQuestions(3) })
  await seed(email, topic, { warmup: true })
  await page.setViewportSize(DESKTOP)
  const url = (view: string) => `/courses/${course.courseId}/topics/${topic}?view=${view}`

  // Warm-up is next. On its own step there is no line; on a step the student chose (Quiz) there is none either.
  await page.goto(url('warmup'))
  await expect(page.getByRole('button', { name: 'Start warm-up' })).toBeVisible()
  await expect(line(page)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Start learning' })).toHaveCount(0)
  await page.goto(url('quiz'))
  await expect(line(page)).toHaveCount(0)
  // The path itself tags the one step, and a tool (Examples) carries the same advice as one quiet line.
  await expect(page.getByRole('navigation', { name: 'Topic path' }).getByRole('link', { name: /Warm-up/ })).toContainText('Next')
  await page.goto(url('examples'))
  await expect(line(page)).toContainText('Try a few questions before reading.')
  await expect(line(page).getByRole('link', { name: 'Start warm-up' })).toHaveAttribute('href', url('warmup'))
  // The line is a link, not a primary button.
  expect(await line(page).getByRole('link', { name: 'Start warm-up' }).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
})

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
  // The row says where the topic stands in words and a bar: what is next, and how many of its steps are done. No strip of icons.
  await expect(row).toContainText('Next: Warm-up')
  await expect(row).toContainText(/0 of \d steps done/)
  await expect(row.locator('[role="img"]')).toHaveCount(0)
  await expectNoAxeViolations(page, 'topics list')
  // The topic opens on the step the row named.
  await page.goto(`/courses/${course.courseId}/topics/${topic}`)
  await expect(page).toHaveURL(/view=warmup/)
})
