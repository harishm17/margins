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

test('the material role can be changed, and a syllabus or exam stops being a source', async ({ page }) => {
  await signIn(page, email)

  const bad = await page.request.patch(`/api/materials/${materials.docx}`, { data: { role: 'homework' } })
  expect(bad.status()).toBe(400)
  const missing = await page.request.patch('/api/materials/00000000-0000-0000-0000-000000000000', { data: { role: 'exam' } })
  expect(missing.status()).toBe(404)

  const before = await withPrisma((prisma) => prisma.topicSource.count({ where: { materialId: materials.docx } }))
  expect(before).toBeGreaterThan(0)
  const toExam = await json(await page.request.patch(`/api/materials/${materials.docx}`, { data: { role: 'exam' } }))
  expect(toExam.material).toEqual({ id: materials.docx, role: 'exam', removedSources: before })
  expect(await withPrisma((prisma) => prisma.topicSource.count({ where: { materialId: materials.docx } }))).toBe(0)
  expect(
    await withPrisma((prisma) => prisma.topicChunkMapping.count({ where: { chunk: { materialId: materials.docx } } }))
  ).toBe(0)

  const back = await json(await page.request.patch(`/api/materials/${materials.docx}`, { data: { role: 'content' } }))
  expect(back.material).toEqual({ id: materials.docx, role: 'content', removedSources: 0 })
  const list = (await json(await page.request.get(`/api/projects/${courseId}/materials`))).materials as Record<string, any>[]
  expect(list.find((item) => item.id === materials.docx)?.role).toBe('content')
})

test('units: add, rename, move, delete; topics: move between units, prerequisites, add into a unit, merge', async ({ page }) => {
  await signIn(page, email)

  const state = () =>
    withPrisma(async (prisma) => ({
      units: await prisma.unit.findMany({ where: { projectId: courseId }, orderBy: { orderIndex: 'asc' } }),
      topics: await prisma.topic.findMany({ where: { projectId: courseId }, orderBy: { orderIndex: 'asc' }, include: { sources: true } }),
    }))
  const initial = await state()
  const [unitA, unitB] = initial.units

  // Add a unit (last), rename it, give it a week label, move it first, then delete it empty.
  const created = await json(await page.request.post(`/api/projects/${courseId}/units`, { data: { title: 'Extra week', weekLabel: 'Week 9' } }))
  expect(created.unit).toMatchObject({ title: 'Extra week', weekLabel: 'Week 9', orderIndex: initial.units.length })
  const renamed = await json(await page.request.patch(`/api/units/${created.unit.id}`, { data: { title: 'Extra', summary: 'More.', orderIndex: 0 } }))
  expect(renamed.unit).toMatchObject({ title: 'Extra', summary: 'More.', weekLabel: 'Week 9', orderIndex: 0 })
  expect((await state()).units.map((unit) => unit.id)).toEqual([created.unit.id, unitA.id, unitB.id])
  expect((await page.request.post(`/api/projects/${courseId}/units`, { data: { title: '  ' } })).status()).toBe(400)

  // Moving a unit up moved nothing in topics yet (it is empty), then topics follow their unit.
  const first = initial.topics.find((topic) => topic.unitId === unitA.id)!
  const second = initial.topics.find((topic) => topic.unitId === unitB.id)!

  // Move a topic into the new unit: it is last (and only) there, and the course order follows the units.
  const moved = await json(await page.request.patch(`/api/topics/${first.id}`, { data: { unitId: created.unit.id } }))
  expect(moved.topic.unitId).toBe(created.unit.id)
  let now = await state()
  expect(now.topics[0].id).toBe(first.id)
  expect(now.topics.map((topic) => topic.orderIndex)).toEqual(now.topics.map((_topic, index) => index))
  // A unit with topics cannot be deleted.
  expect((await page.request.delete(`/api/units/${created.unit.id}`)).status()).toBe(409)

  // Move it back to its own unit at a position: the unit's topics stay together.
  await page.request.patch(`/api/topics/${first.id}`, { data: { unitId: unitA.id, orderIndex: 0 } })
  now = await state()
  expect(now.topics.find((topic) => topic.id === first.id)!.unitId).toBe(unitA.id)
  expect(now.units.length).toBe(initial.units.length + 1)
  expect((await page.request.delete(`/api/units/${created.unit.id}`)).ok()).toBe(true)
  expect((await state()).units.map((unit) => unit.orderIndex)).toEqual(initial.units.map((_unit, index) => index))
  expect((await page.request.patch(`/api/topics/${first.id}`, { data: { unitId: '00000000-0000-0000-0000-000000000000' } })).status()).toBe(404)

  // Editing a topic's own structure.
  const edited = await json(
    await page.request.patch(`/api/topics/${second.id}`, {
      data: { objectives: ['do one thing', 'do another'], estimatedMinutes: 40, prerequisiteIds: [first.id, first.id, second.id, 'nope'] },
    })
  )
  expect(edited.topic).toMatchObject({ objectives: ['do one thing', 'do another'], estimatedMinutes: 40, prerequisiteIds: [first.id] })
  // first -> second -> first would be a loop.
  const loop = await page.request.patch(`/api/topics/${first.id}`, { data: { prerequisiteIds: [second.id] } })
  expect(loop.status()).toBe(400)

  // Add a topic by hand into a unit: last in that unit, no sources, no objectives.
  const added = await json(await page.request.post(`/api/projects/${courseId}/topics`, { data: { name: 'Added into a unit', unitId: unitA.id } }))
  expect(added.topic).toMatchObject({ unitId: unitA.id, objectives: [], prerequisiteIds: [], userConfirmed: true })
  now = await state()
  const inA = now.topics.filter((topic) => topic.unitId === unitA.id)
  expect(inA[inA.length - 1].id).toBe(added.topic.id)
  expect(now.topics.map((topic) => topic.orderIndex)).toEqual(now.topics.map((_topic, index) => index))
  const plain = await json(await page.request.post(`/api/projects/${courseId}/topics`, { data: { name: 'No unit' } }))
  expect(plain.topic.unitId).toBeNull()

  // Merge: the source's sources and prerequisites move to the target; others that needed it follow.
  const sourceCount = now.topics.find((topic) => topic.id === second.id)!.sources.length
  const targetCount = now.topics.find((topic) => topic.id === first.id)!.sources.length
  const merged = await json(
    await page.request.post(`/api/projects/${courseId}/topics/merge`, { data: { sourceTopicId: second.id, targetTopicId: first.id } })
  )
  expect(merged.mergedTopicId).toBe(second.id)
  now = await state()
  const target = now.topics.find((topic) => topic.id === first.id)!
  expect(target.sources.length).toBe(sourceCount + targetCount)
  expect(target.prerequisiteIds).not.toContain(second.id)
  expect(target.prerequisiteIds).not.toContain(first.id)
  expect(target.objectives).toEqual(expect.arrayContaining(['do one thing', 'do another']))
  expect(target.estimatedMinutes).toBeGreaterThanOrEqual(40)
  expect(now.topics.some((topic) => topic.prerequisiteIds.includes(second.id))).toBe(false)

  // Deleting a topic removes it from other topics' prerequisites.
  const dependent = await json(await page.request.patch(`/api/topics/${added.topic.id}`, { data: { prerequisiteIds: [first.id] } }))
  expect(dependent.topic.prerequisiteIds).toEqual([first.id])
  expect((await page.request.delete(`/api/topics/${first.id}`)).ok()).toBe(true)
  now = await state()
  expect(now.topics.find((topic) => topic.id === added.topic.id)!.prerequisiteIds).toEqual([])
  expect(now.topics.some((topic) => topic.id === first.id)).toBe(false)
})

test('the topic page and the topics list show the course unchanged while it has units', async ({ page }) => {
  await signIn(page, email)

  await page.goto(`/courses/${courseId}/topics`)
  await expect(page.getByRole('heading', { level: 1, name: 'Check the topics' })).toBeVisible()
  const rows = page.getByRole('list', { name: 'Topics' }).getByRole('listitem')
  expect(await rows.count()).toBeGreaterThanOrEqual(2)
  await page.getByRole('button', { name: 'Confirm topics' }).click()
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}$`))
})
