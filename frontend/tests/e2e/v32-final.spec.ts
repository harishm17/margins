import { expect, test } from '@playwright/test'
import { withPrisma } from './helpers/db'
import { ZONE } from './helpers/loop'
import { trueFalse, world } from './helpers/v31-sessions'

// v3.2 final pass: regressions found while verifying the integration branch.

test.use({ timezoneId: ZONE })

test('a quiz set that arrives while a quiz is open does not change the questions', async ({ page }) => {
  test.setTimeout(120_000)
  const w = await world(page, `v32-pin-${Date.now()}`, [{ name: 'Graphs', concepts: ['Queues', 'Stacks'] }])
  const concepts = Object.values(w.concepts)
  const topicId = w.topics.Graphs
  const first = Array.from({ length: 4 }, (_, i) => trueFalse(`First set statement ${i + 1} holds.`, [concepts[i % concepts.length]]))
  const newer = Array.from({ length: 4 }, (_, i) => trueFalse(`Newer set statement ${i + 1} holds.`, [concepts[i % concepts.length]]))
  await withPrisma((prisma) => prisma.topicQuiz.create({ data: { topicId, questions: first } }))

  await page.goto(`/courses/${w.courseId}/topics/${topicId}?view=quiz`)
  await page.getByRole('button', { name: 'Start quiz' }).click()
  await expect(page.getByText('First set statement 1 holds.')).toBeVisible()
  await page.getByRole('radio', { name: 'True' }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByText('First set statement 2 holds.')).toBeVisible()

  // A generation finishes in the background: a newer set is stored and the page is told to refresh
  // (the address names the finished job, which the topic page follows and then refreshes).
  const jobId = await withPrisma(async (prisma) => {
    await prisma.topicQuiz.create({ data: { topicId, questions: newer } })
    const user = await prisma.user.findUniqueOrThrow({ where: { email: w.email }, select: { id: true } })
    const job = await prisma.processingJob.create({
      data: { userId: user.id, projectId: w.courseId, jobType: 'generate_content', status: 'completed', completedAt: new Date(), progressPercent: 100 },
    })
    return job.id
  })
  // The page replaces the quiz view when a newer set arrives, so the old question element going away is the sign that the new data landed.
  const oldQuestion = await page.getByText('First set statement 2 holds.').elementHandle()
  const refreshed = page.waitForResponse((response) => response.url().includes('_rsc=') && response.url().includes('view=quiz') && response.url().includes('job=') && response.url().includes(`/topics/${topicId}`) && response.ok())
  await page.evaluate((id) => window.history.pushState(null, '', `${window.location.pathname}?view=quiz&job=${id}`), jobId)
  await refreshed
  await page.waitForFunction((element) => !element?.isConnected, oldQuestion)
  // The refreshed page has both sets, but the open quiz keeps its own questions and its place.
  await expect(page.getByText('First set statement 2 holds.')).toBeVisible()
  await expect(page.getByText('Question 2 of 4')).toBeVisible()
  await expect(page.getByText('Newer set statement')).toHaveCount(0)

  // The new data has landed once the lobby offers a choice of sets; the saved quiz is still the first set's.
  await page.getByRole('button', { name: 'Exit' }).click()
  await page.getByRole('dialog', { name: 'Leave this quiz?' }).getByRole('button', { name: 'Save and finish later' }).click()
  await expect(page.getByRole('combobox', { name: 'Quiz set' })).toContainText('Set 1')
  await expect(page.getByRole('button', { name: 'Resume (1 of 4 answered)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start quiz' })).toHaveCount(0)
})
