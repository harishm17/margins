import { readFileSync } from 'node:fs'
import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { withPrisma } from './helpers/db'
import { FIXTURE_PDF } from './helpers/seed-demo'

// Past exams end to end on the mock AI service: a file uploaded as a past exam gets a style profile,
// the new-exam form offers "Match my past exams" (on), the exam job receives the choice, and the
// profile goes away (and the toggle with it) when the file stops being an exam.
const stamp = Date.now()
const email = `past-exams-${stamp}@example.com`

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let courseId = ''
let examId = ''

const json = async (response: APIResponse) => (await response.json()) as Record<string, any>

async function upload(page: Page, category: string, filename: string) {
  const response = await page.request.post(`/api/projects/${courseId}/materials?category=${category}&filename=${filename}`, {
    data: readFileSync(FIXTURE_PDF),
    headers: { 'content-type': 'application/pdf' },
  })
  expect(response.ok(), `upload ${filename}`).toBeTruthy()
  return (await json(response)).material as Record<string, any>
}

const styleProfile = () =>
  withPrisma(async (prisma) => (await prisma.material.findUnique({ where: { id: examId }, select: { styleProfile: true } }))?.styleProfile ?? null)

const completedJobs = (jobType: string) =>
  withPrisma((prisma) => prisma.processingJob.count({ where: { projectId: courseId, jobType, status: 'completed' } }))

test('a past exam gets a style profile and the new-exam form offers to match it', async ({ page }) => {
  // The first sign-in makes the account.
  await signIn(page, email)

  courseId = (await json(await page.request.post('/api/projects', { data: { name: `Past exams ${stamp}` } }))).project.id
  await upload(page, 'lecture_notes', 'algorithms.pdf')
  const exam = await upload(page, 'sample_exams', 'midterm.pdf')
  expect(exam.role).toBe('exam')
  examId = exam.id

  // Chunking starts the two past-exam jobs: the profile (a model call) and the topic relevance.
  await expect.poll(styleProfile, { timeout: 180_000, intervals: [2000] }).not.toBeNull()
  const profile = (await styleProfile()) as Record<string, any>
  expect(profile).toMatchObject({ version: 1, multi_part: expect.any(Boolean) })
  expect(profile.example_stems).toHaveLength(3)
  expect(profile.task_verbs.length).toBeGreaterThan(0)
  await expect.poll(() => completedJobs('exam_relevance'), { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(0)

  // Topics are planned once the last file is processed; the relevance column exists and is readable.
  await expect
    .poll(async () => (await json(await page.request.get(`/api/projects/${courseId}/topics`))).topics.length, {
      timeout: 180_000,
      intervals: [2000],
    })
    .toBeGreaterThan(0)
  // The planner marks the topics the exam questions test (the mock leaves the last topic out).
  const flagged = () =>
    withPrisma((prisma) =>
      prisma.topic.findMany({ where: { projectId: courseId }, orderBy: { orderIndex: 'asc' }, select: { examRelevant: true } })
    )
  await expect.poll(async () => (await flagged()).some((row) => row.examRelevant), { timeout: 60_000, intervals: [1000] }).toBe(true)
  const flags = await flagged()
  if (flags.length > 1) expect(flags[flags.length - 1].examRelevant).toBe(false)
  const map = await withPrisma(
    async (prisma) => (await prisma.material.findUnique({ where: { id: examId }, select: { examTopicMap: true } }))?.examTopicMap
  )
  expect(map).toMatchObject({ version: 1, questions: expect.any(Array) })
  expect((map as { questions: unknown[] }).questions.length).toBeGreaterThan(0)
  await page.request.post(`/api/projects/${courseId}/topics/confirm`)
})

test('the form shows "Match my past exams" on, and the choice reaches the exam job', async ({ page }) => {
  await signIn(page, email)
  await page.goto(`/courses/${courseId}/exams/new`)
  const toggle = page.getByRole('checkbox', { name: /Match my past exams/ })
  await expect(toggle).toBeChecked()

  await page.getByRole('radio', { name: '10', exact: true }).click()
  await page.getByRole('button', { name: 'Create exam' }).click()
  await expect(page.getByText('Writing your exam')).toBeVisible()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })

  // Off: the second exam is not matched. (The first one was.)
  await page.goto(`/courses/${courseId}/exams/new`)
  await page.getByRole('checkbox', { name: /Match my past exams/ }).click()
  await expect(page.getByRole('checkbox', { name: /Match my past exams/ })).not.toBeChecked()
  await page.getByRole('radio', { name: '20', exact: true }).click()
  await page.getByRole('button', { name: 'Create exam' }).click()
  await expect(page).toHaveURL(/\/exams\/[0-9a-f-]{36}$/, { timeout: 180_000 })

  const jobs = await withPrisma((prisma) =>
    prisma.processingJob.findMany({
      where: { projectId: courseId, jobType: 'generate_exam', status: 'completed' },
      orderBy: { createdAt: 'asc' },
      select: { inputData: true, resultData: true },
    })
  )
  expect(jobs).toHaveLength(2)
  expect((jobs[0].inputData as any).config.match_past_exams).toBe(true)
  expect((jobs[0].resultData as any).matched_past_exams).toBe(true)
  expect((jobs[1].inputData as any).config.match_past_exams).toBeUndefined()
  expect((jobs[1].resultData as any).matched_past_exams).toBe(false)
})

test('when the file stops being an exam the profile and the toggle go; making it one again brings them back', async ({ page }) => {
  await signIn(page, email)
  const relevanceJobs = await completedJobs('exam_relevance')

  const away = await json(await page.request.patch(`/api/materials/${examId}`, { data: { role: 'content' } }))
  expect(away.material.role).toBe('content')
  expect(await styleProfile()).toBeNull()
  await expect
    .poll(() => withPrisma((prisma) => prisma.material.findUnique({ where: { id: examId }, select: { examTopicMap: true } })).then((row) => row?.examTopicMap ?? null), { timeout: 5_000 })
    .toBeNull()
  await expect.poll(() => completedJobs('exam_relevance'), { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(relevanceJobs)
  await page.goto(`/courses/${courseId}/exams/new`)
  await expect(page.getByRole('radio', { name: '10', exact: true })).toBeVisible()
  await expect(page.getByText('Match my past exams')).toHaveCount(0)

  await page.request.patch(`/api/materials/${examId}`, { data: { role: 'exam' } })
  await expect.poll(styleProfile, { timeout: 120_000, intervals: [1000] }).not.toBeNull()
  await page.goto(`/courses/${courseId}/exams/new`)
  await expect(page.getByRole('checkbox', { name: /Match my past exams/ })).toBeChecked()
})
