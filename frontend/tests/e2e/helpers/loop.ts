import { readFileSync } from 'node:fs'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import { withPrisma } from './db'
import { FIXTURE_PDF } from './seed-demo'
import { signIn } from './auth'

/** Helpers for the learning loop specs: a fresh account and course per spec, built through the app's own API. */

/** The zone the browser runs in for these specs; the plan is laid out in the student's own days. */
export const ZONE = 'America/Los_Angeles'

/** Today plus `offset` days as YYYY-MM-DD in `zone`. */
export function dayIn(zone: string, offset = 0, now = new Date()): string {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const [year, month, day] = base.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + offset))
  return shifted.toISOString().slice(0, 10)
}

/** Tells the server the browser's time zone before the first page load (the app also does this itself). */
export async function setZoneCookie(context: BrowserContext, zone = ZONE) {
  await context.addCookies([{ name: 'margins_tz', value: encodeURIComponent(zone), domain: 'localhost', path: '/' }])
}

let account: { email: string } | null = null

/**
 * Signs in as the spec file's account; the first sign-in makes it. One account serves every spec in
 * the file (each makes its own course).
 */
export async function signUpAndIn(page: Page, label: string): Promise<{ email: string }> {
  account ??= { email: `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com` }
  await signIn(page, account.email)
  return account
}

export { signIn }

export type TopicSpec = {
  name: string
  minutes?: number
  unit?: string
  /** Name of the topic this one builds on (it must come earlier in the list). */
  after?: string
}

export type LoopCourse = { courseId: string; topics: Record<string, string>; units: Record<string, string> }

/**
 * A confirmed course with topics (in the given order), optional units, prerequisites and minutes.
 * Signed in as the user that is on `page`.
 */
export async function createCourse(
  page: Page,
  name: string,
  topics: TopicSpec[],
  options: { examDate?: string; dailyMinutes?: number; existingCourseId?: string } = {}
): Promise<LoopCourse> {
  const { existingCourseId, ...settings } = options
  let courseId = existingCourseId
  if (!courseId) {
    const created = await page.request.post('/api/projects', { data: { name, ...settings } })
    expect(created.ok()).toBeTruthy()
    courseId = (await created.json()).project.id as string
    // A confirmed course has files: with none and nothing written there is nothing to study from, so
    // setup is back at step 1 and there is no plan (lib/course-setup.ts). A file row is enough for the
    // specs that write their content straight into the database; addMaterial is for real text.
    await addFileRow(courseId)
  } else if (settings.examDate || settings.dailyMinutes) {
    const patched = await page.request.patch(`/api/projects/${courseId}`, { data: settings })
    expect(patched.ok()).toBeTruthy()
  }

  const units: Record<string, string> = {}
  for (const title of [...new Set(topics.flatMap((topic) => (topic.unit ? [topic.unit] : [])))]) {
    const response = await page.request.post(`/api/projects/${courseId}/units`, { data: { title } })
    expect(response.ok()).toBeTruthy()
    units[title] = (await response.json()).unit.id as string
  }

  const ids: Record<string, string> = {}
  for (const spec of topics) {
    const response = await page.request.post(`/api/projects/${courseId}/topics`, {
      data: { name: spec.name, ...(spec.unit ? { unitId: units[spec.unit] } : {}) },
    })
    expect(response.ok()).toBeTruthy()
    ids[spec.name] = (await response.json()).topic.id as string
  }
  for (const spec of topics) {
    const patch = await page.request.patch(`/api/topics/${ids[spec.name]}`, {
      data: {
        ...(spec.minutes ? { estimatedMinutes: spec.minutes } : {}),
        ...(spec.after ? { prerequisiteIds: [ids[spec.after]] } : {}),
      },
    })
    expect(patch.ok()).toBeTruthy()
  }
  expect((await page.request.post(`/api/projects/${courseId}/topics/confirm`)).ok()).toBeTruthy()
  return { courseId, topics: ids, units }
}

/** A read file in the course, written straight into the database (no upload, no text to teach from). */
export async function addFileRow(courseId: string, filename = 'notes.pdf') {
  await withPrisma(async (prisma) => {
    await prisma.material.create({
      data: { projectId: courseId, category: 'lecture_notes', filename, gcsPath: `e2e/${courseId}/${filename}`, sizeBytes: BigInt(1024), validationStatus: 'valid' },
    })
  })
}

/** Writes study content straight into the database, so a spec does not wait for the model. */
export async function addContent(topicId: string, contents: Partial<Record<string, unknown>>) {
  await withPrisma(async (prisma) => {
    for (const [contentType, contentData] of Object.entries(contents)) {
      await prisma.topicContent.upsert({
        where: { topicId_contentType: { topicId, contentType } },
        create: { topicId, contentType, contentData: contentData as object },
        update: { contentData: contentData as object },
      })
    }
  })
}

/** True/false questions with a known key (all true), tagged with a concept each. */
export const quizQuestions = (count = 4) =>
  Array.from({ length: count }, (_, index) => ({
    question_type: 'true_false',
    question_text: `Statement ${index + 1} about graphs holds.`,
    correct_answer: true,
    explanation: `Statement ${index + 1} is true.`,
    points: 1,
    difficulty: 'easy',
    concepts_tested: [`Concept ${index + 1}`],
  }))

/** One practice problem with two numeric steps (answers 4 and 9). */
export const practiceProblem = (title = 'Squares') => ({
  title,
  problem_statement: 'Work out two squares.',
  difficulty: 'easy',
  key_concepts: ['Squares'],
  estimated_time_minutes: 3,
  steps: [
    {
      step_number: 1,
      question: 'What is 2 squared?',
      hint: 'Multiply 2 by itself.',
      answer_type: 'numeric',
      correct_answer: '4',
      acceptable_answers: [],
      explanation: '2 times 2 is 4.',
      feedback_correct: 'Yes.',
      feedback_incorrect: 'Not that one.',
    },
    {
      step_number: 2,
      question: 'What is 3 squared?',
      hint: 'Multiply 3 by itself.',
      answer_type: 'numeric',
      correct_answer: '9',
      acceptable_answers: [],
      explanation: '3 times 3 is 9.',
      feedback_correct: 'Yes.',
      feedback_incorrect: 'Not that one.',
    },
  ],
})

/** Makes a topic's review due (a day ago) with the given mastery. */
export async function makeDue(topicId: string, userEmail: string, options: { mastery?: number; intervalDays?: number; daysAgo?: number } = {}) {
  await withPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: userEmail }, select: { id: true } })
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId }, select: { projectId: true } })
    const dueAt = new Date(Date.now() - (options.daysAgo ?? 1) * 86_400_000)
    await prisma.reviewSchedule.upsert({
      where: { userId_topicId: { userId: user.id, topicId } },
      create: { userId: user.id, projectId: topic.projectId, topicId, mastery: options.mastery ?? 0.5, dueAt, intervalDays: options.intervalDays ?? 3 },
      update: { dueAt, ...(options.mastery !== undefined ? { mastery: options.mastery } : {}), intervalDays: options.intervalDays ?? 3 },
    })
  })
}

/**
 * Uploads the sample PDF so topics have text to write from, waits until topic finding has finished
 * (it would otherwise undo the confirmation of the hand-made topics) and removes the topics it made.
 * Call before `createCourse` topics are confirmed: create the course first, add the material, then the topics.
 */
export async function addMaterial(page: Page, courseId: string) {
  const upload = await page.request.post(`/api/projects/${courseId}/materials?category=lecture_notes&filename=algorithms.pdf`, {
    data: readFileSync(FIXTURE_PDF),
    headers: { 'content-type': 'application/pdf' },
  })
  expect(upload.ok()).toBeTruthy()
  await expect
    .poll(async () => (await (await page.request.get(`/api/projects/${courseId}/materials`)).json()).materials.map((m: { validationStatus: string }) => m.validationStatus).join(), { timeout: 120_000 })
    .toBe('valid')
  await expect
    .poll(async () => (await (await page.request.get(`/api/projects/${courseId}/topics`)).json()).topics.length, { timeout: 120_000 })
    .toBeGreaterThan(0)
  const { topics } = await (await page.request.get(`/api/projects/${courseId}/topics`)).json()
  for (const topic of topics as { id: string }[]) await page.request.delete(`/api/topics/${topic.id}`)
}

/** An empty course, to add a material to before its topics exist. */
export async function createEmptyCourse(page: Page, name: string): Promise<string> {
  const created = await page.request.post('/api/projects', { data: { name } })
  expect(created.ok()).toBeTruthy()
  return (await created.json()).project.id as string
}
