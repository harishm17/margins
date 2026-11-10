import { expect, test, type Page } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { addContent, createCourse as createLoopCourse, signUpAndIn } from './helpers/loop'

// The generate-content route and the course overview's concept preparation, through the real app
// against the mock AI service: a concepts job that is already running is returned and followed, and
// a course whose extraction failed is retried once a day, a bounded number of times.
const HOUR = 60 * 60 * 1000

async function createCourse(page: Page) {
  const course = await createLoopCourse(page, `Generate content ${Date.now()}`, [{ name: 'Graph traversal' }])
  const topicId = course.topics['Graph traversal']
  // Written notes put the course past setup, where its overview is the Today view.
  await addContent(topicId, { section_notes: '# Graph traversal\n\nNotes.' })
  return { projectId: course.courseId, topicId }
}

async function seedConceptsJob(
  projectId: string,
  topicId: string,
  userEmail: string,
  status: string,
  ageHours = 0
) {
  return withPrisma(async (prisma) => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: userEmail } })
    const at = new Date(Date.now() - ageHours * HOUR)
    return prisma.processingJob.create({
      data: {
        userId: user.id,
        projectId,
        jobType: 'generate_content',
        status,
        stage: 'generating',
        targetKey: `concepts:${projectId}`,
        inputData: { topicId, contentType: 'concepts', preferences: { prepare_concepts: true } },
        createdAt: at,
        completedAt: status === 'failed' ? at : null,
        errorCode: status === 'failed' ? 'LLM_OUTPUT' : null,
        retryable: status === 'failed',
      },
    })
  })
}

const conceptsJobs = (projectId: string) =>
  withPrisma((prisma) =>
    prisma.processingJob.count({
      where: { projectId, jobType: 'generate_content', inputData: { path: ['contentType'], equals: 'concepts' } },
    })
  )

test.describe.configure({ mode: 'serial' })

test('the course overview retries a failed extraction once a day, a bounded number of times', async ({ page }) => {
  const { email } = await signUpAndIn(page, 'generate-content')

  // Failed an hour ago: not tried again yet.
  const recent = await createCourse(page)
  await seedConceptsJob(recent.projectId, recent.topicId, email, 'failed', 1)
  // Failed four times already (the first attempt and three retries): left alone.
  const spent = await createCourse(page)
  for (const hours of [25, 50, 75, 100]) await seedConceptsJob(spent.projectId, spent.topicId, email, 'failed', hours)
  // Failed a day and a bit ago: the overview starts a new attempt.
  const stale = await createCourse(page)
  await seedConceptsJob(stale.projectId, stale.topicId, email, 'failed', 25)

  // Nothing to wait for on the two that are left alone, so their pages are opened first and the retry of the third is
  // what is awaited: by the time its job exists the overview has run for the others too, and they have none new.
  for (const left of [recent, spent]) {
    await page.goto(`/courses/${left.projectId}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  }
  await page.goto(`/courses/${stale.projectId}`)
  await expect.poll(() => conceptsJobs(stale.projectId), { timeout: 30_000 }).toBe(2)
  expect(await conceptsJobs(recent.projectId)).toBe(1)
  expect(await conceptsJobs(spent.projectId)).toBe(4)

  // A topic's own failed concepts jobs do not spend the course's retry budget.
  const topicJobs = await createCourse(page)
  await seedConceptsJob(topicJobs.projectId, topicJobs.topicId, email, 'failed', 25)
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findFirstOrThrow({ where: { email } })
    for (const hours of [30, 40, 50, 60]) {
      await prisma.processingJob.create({
        data: {
          userId: user.id,
          projectId: topicJobs.projectId,
          jobType: 'generate_content',
          status: 'failed',
          targetKey: `content:${topicJobs.topicId}:concepts`,
          inputData: { topicId: topicJobs.topicId, contentType: 'concepts', preferences: {} },
          createdAt: new Date(Date.now() - hours * HOUR),
          completedAt: new Date(Date.now() - hours * HOUR),
        },
      })
    }
  })
  const before = await conceptsJobs(topicJobs.projectId)
  await page.goto(`/courses/${topicJobs.projectId}`)
  await expect.poll(() => conceptsJobs(topicJobs.projectId), { timeout: 30_000 }).toBeGreaterThan(before)
})
