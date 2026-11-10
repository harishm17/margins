import { readFileSync } from 'node:fs'
import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { signIn } from './helpers/auth'
import { withPrisma } from './helpers/db'
import { FIXTURE_DOCX, FIXTURE_PDF } from './helpers/seed-demo'

// Course structure end to end, through the app's own API on the mock AI service: the planner
// writes units, topics with objectives and prerequisites, and topic sources; material roles; and
// the editor routes for units and topics. One account per run.
const stamp = Date.now()
const email = `structure-${stamp}@example.com`

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let courseId = ''
let materials: Record<string, string> = {}

const json = async (response: APIResponse) => (await response.json()) as Record<string, any>

async function topics(page: Page) {
  return (await json(await page.request.get(`/api/projects/${courseId}/topics`))).topics as Record<string, any>[]
}

async function upload(page: Page, category: string, filename: string, file: string, mime: string) {
  const response = await page.request.post(`/api/projects/${courseId}/materials?category=${category}&filename=${filename}`, {
    data: readFileSync(file),
    headers: { 'content-type': mime },
  })
  expect(response.ok(), `upload ${filename}`).toBeTruthy()
  return (await json(response)).material as Record<string, any>
}

test('upload content and a syllabus: roles are set and the plan has units and sources', async ({ page }) => {
  // The first sign-in makes the account.
  await signIn(page, email)

  courseId = (await json(await page.request.post('/api/projects', { data: { name: `Structure ${stamp}` } }))).project.id
  // The syllabus goes first, so every other file is chunked before topic finding can start.
  const syllabus = await upload(page, 'syllabus', 'schedule.pdf', FIXTURE_PDF, 'application/pdf')
  expect(syllabus.role).toBe('syllabus')
  const pdf = await upload(page, 'lecture_notes', 'algorithms.pdf', FIXTURE_PDF, 'application/pdf')
  const docx = await upload(
    page,
    'lecture_notes',
    'hashing.docx',
    FIXTURE_DOCX,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
  const exam = await upload(page, 'sample_exams', 'midterm.pdf', FIXTURE_PDF, 'application/pdf')
  expect(exam.role).toBe('exam')
  materials = { syllabus: syllabus.id, pdf: pdf.id, docx: docx.id, exam: exam.id }

  await expect
    .poll(
      async () => {
        const body = await json(await page.request.get(`/api/projects/${courseId}/materials`))
        return body.materials.every((item: Record<string, any>) => item.validationStatus === 'valid')
      },
      { timeout: 180_000 }
    )
    .toBe(true)
  // Topic finding starts by itself after the last file; start it if two files finished together.
  await expect
    .poll(
      async () => {
        if ((await topics(page)).length > 0) return true
        const active = await json(await page.request.get(`/api/jobs?active=1&projectId=${courseId}&types=extract_topics,chunk_material`))
        if ((active.jobs ?? []).length === 0) await page.request.post(`/api/projects/${courseId}/extract-topics`)
        return false
      },
      { timeout: 180_000, intervals: [2000] }
    )
    .toBe(true)

  // Roles: syllabus and exam by category, the validator (a mock) says content for the others.
  const roles = await withPrisma((prisma) =>
    prisma.material.findMany({ where: { projectId: courseId }, select: { filename: true, role: true } })
  )
  expect(Object.fromEntries(roles.map((row) => [row.filename, row.role]))).toEqual({
    'schedule.pdf': 'syllabus',
    'algorithms.pdf': 'content',
    'hashing.docx': 'content',
    'midterm.pdf': 'exam',
  })

  const rows = await withPrisma(async (prisma) => ({
    units: await prisma.unit.findMany({ where: { projectId: courseId }, orderBy: { orderIndex: 'asc' } }),
    topics: await prisma.topic.findMany({
      where: { projectId: courseId },
      orderBy: { orderIndex: 'asc' },
      include: { sources: true },
    }),
  }))
  expect(rows.units.length).toBeGreaterThanOrEqual(2)
  expect(rows.units.map((unit) => unit.orderIndex)).toEqual(rows.units.map((_unit, index) => index))
  expect(rows.topics.length).toBeGreaterThanOrEqual(2)
  expect(rows.topics.map((topic) => topic.orderIndex)).toEqual(rows.topics.map((_topic, index) => index))
  for (const topic of rows.topics) {
    expect(topic.userConfirmed).toBe(false)
    expect(topic.unitId).not.toBeNull()
    expect(topic.objectives.length).toBeGreaterThanOrEqual(3)
    expect(topic.estimatedMinutes).toBeGreaterThan(0)
    expect(topic.sources.length).toBeGreaterThan(0)
    // Only content files are sources: never the syllabus or the exam.
    expect(topic.sources.every((source) => [materials.pdf, materials.docx].includes(source.materialId))).toBe(true)
  }
  expect(rows.topics.some((topic) => topic.prerequisiteIds.length > 0)).toBe(true)
  const position = new Map(rows.topics.map((topic) => [topic.id, topic.orderIndex]))
  for (const topic of rows.topics) {
    for (const prerequisite of topic.prerequisiteIds) expect(position.get(prerequisite)).toBeLessThan(topic.orderIndex)
  }
  expect((await topics(page))[0]).toMatchObject({ unitId: rows.topics[0].unitId, objectives: rows.topics[0].objectives })
})
