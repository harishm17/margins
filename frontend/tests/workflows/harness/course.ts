import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, type BrowserContext, type Page, type Route } from '@playwright/test'

/**
 * A student and their course, built the way a student builds one: sign up, create the course, upload files,
 * wait for the topics, check them and confirm. The names stay the same from run to run: the course name and the
 * file names reach the model's prompts, and the recordings are matched by prompt.
 */

export const ZONE = 'America/Los_Angeles'
export const COURSE_NAME = 'Introduction to Algorithms'

/** The files a workflow course is built from (scripts/workflow-files.py makes them). */
export const FILES = {
  lecture1: 'lecture-1.pdf',
  lecture2: 'lecture-2.pdf',
  slides: 'lecture-3.pptx',
  scan: 'lecture-4-scan.pdf',
  pastExam: 'quiz-1.pdf',
} as const

/** Two lectures: the course most workflows study. */
export const CORE_FILES = [FILES.lecture1, FILES.lecture2]

export function courseFile(name: string): string {
  const dir = process.env.WF_FILES_DIR
  if (!dir) throw new Error('Set WF_FILES_DIR to the course files (scripts/workflow-files.py makes them)')
  const file = path.join(dir, name)
  if (!existsSync(file)) throw new Error(`${file} is missing: run scripts/workflow-files.py`)
  return file
}

/** Today plus `offset` days as YYYY-MM-DD in the suite's time zone. */
export function dayIn(offset = 0, now = new Date()): string {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const [year, month, day] = base.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10)
}

export async function setZoneCookie(context: BrowserContext) {
  await context.addCookies([{ name: 'margins_tz', value: encodeURIComponent(ZONE), domain: 'localhost', path: '/' }])
}

/** Signs up a new student (the first sign-in with an address makes the account) and waits for Home. */
export async function newStudent(page: Page, workflow: string): Promise<{ email: string }> {
  const email = `${workflow.toLowerCase()}-student@example.com`
  await setZoneCookie(page.context())
  await page.goto('/login')
  const form = page.getByRole('form', { name: 'Test sign-in' })
  await form.getByLabel('Email').fill(email)
  await form.getByRole('button', { name: 'Test sign-in' }).click()
  await expect(page).toHaveURL(/\/home$/, { timeout: 60_000 })
  return { email }
}

/** Creates the course and returns its address (/courses/<id>). */
export async function createCourse(page: Page, name = COURSE_NAME): Promise<{ courseUrl: string; courseId: string }> {
  await page.goto('/courses/new')
  await page.getByLabel('Course name').fill(name)
  await page.getByRole('button', { name: 'Create course' }).click()
  await expect(page).toHaveURL(/\/courses\/[0-9a-f-]{36}$/)
  const courseUrl = new URL(page.url()).pathname
  return { courseUrl, courseId: courseUrl.split('/').pop()! }
}

export type Category = 'Lecture notes' | 'Past exams' | 'Book chapters' | 'Syllabus or schedule'

/**
 * Once the topics are found and every file is read, the setup guide folds the upload area to "Add more files". With
 * recorded answers that can happen between two steps, so anything that needs the area opens it first (and only when it is
 * folded: the summary toggles).
 */
export async function openUploadArea(page: Page) {
  const folded = page.locator('details:not([open])').filter({ has: page.locator('summary', { hasText: 'Add more files' }) })
  if (await folded.count()) await folded.locator('summary').click()
}

/** Picks the category, then the files, in the upload area on the page that is open. */
export async function chooseFiles(page: Page, names: string[], category: Category = 'Lecture notes') {
  await openUploadArea(page)
  await page.getByRole('radio', { name: category, exact: true }).click()
  if (names.length > 1) await arriveInOrder(page, names)
  await page.getByLabel('Choose files to upload').setInputFiles(names.map(courseFile))
}

/**
 * Lets a batch's uploads reach the server one at a time, in the order chosen. The browser sends them all at once and the
 * server stamps each file as it arrives; the AI service lists files by that stamp, so without this the topic-finding prompt
 * changes from run to run and the recorded answers stop matching (finding 4, F6; finding 90). The page still shows one
 * batch being uploaded and read.
 */
async function arriveInOrder(page: Page, names: string[]) {
  const done = new Map(names.map((name) => [name, Promise.withResolvers<void>()]))
  const pattern = '**/api/projects/*/materials?*'
  const handler = async (route: Route) => {
    const name = new URL(route.request().url()).searchParams.get('filename') ?? ''
    const position = names.indexOf(name)
    if (route.request().method() !== 'POST' || position < 0) return route.fallback()
    await Promise.all(names.slice(0, position).map((earlier) => done.get(earlier)!.promise))
    try {
      // continue(), not fetch() and fulfill(): fetch() drops a body the browser sends as a file, and the server sees an empty one.
      // The server stores the file before it answers, so the answer is when the next file may go.
      await route.continue()
      await route.request().response()
    } finally {
      done.get(name)!.resolve()
    }
  }
  await page.route(pattern, handler)
  void Promise.all([...done.values()].map((entry) => entry.promise)).then(() => page.unroute(pattern, handler).catch(() => {}))
}

/**
 * Waits until the setup guide offers the topic check. When several files finish at once, topic finding can be
 * missed and the guide offers "Find topics" instead: that is clicked.
 */
export async function waitForTopics(page: Page, courseUrl: string, timeout = 5 * 60_000) {
  const review = page.getByRole('link', { name: 'Review topics' }).first()
  const find = page.getByRole('button', { name: 'Find topics' }).first()
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await review.isVisible()) return
    if (await find.isVisible()) await find.click()
    await page.waitForTimeout(2000)
    if (!new URL(page.url()).pathname.endsWith(courseUrl)) await page.goto(courseUrl)
  }
  throw new Error(`No "Review topics" on ${courseUrl} after ${timeout / 1000} s`)
}

/** Opens the topic check and confirms the topics as found; back on the course page. */
export async function confirmTopics(page: Page, courseUrl: string) {
  await page.goto(`${courseUrl}/topics`)
  await expect(page.getByRole('heading', { level: 1, name: 'Check the topics' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm topics' }).click()
  await expect(page).toHaveURL(courseUrl)
  await expect(page.getByRole('heading', { level: 2, name: 'Start studying' })).toBeVisible()
}

/**
 * A new student with a confirmed course built from `files`, one at a time (so topic finding starts once, after the
 * last). Ends on the course page at "Start studying", with no topic opened yet.
 */
export async function readyCourse(page: Page, workflow: string, files: string[] = CORE_FILES) {
  const student = await newStudent(page, workflow)
  const course = await createCourse(page)
  for (const [index, name] of files.entries()) {
    await chooseFiles(page, [name])
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(index + 1, { timeout: 3 * 60_000 })
  }
  await waitForTopics(page, course.courseUrl)
  await confirmTopics(page, course.courseUrl)
  return { ...student, ...course }
}

/** The setup form's exam date (a month away by default) and "Save and start warm-up": opens the first topic. */
export async function startStudying(page: Page, courseUrl: string, examInDays = 30) {
  const form = page.getByRole('form', { name: 'Exam date and daily time' })
  await form.getByLabel('Exam date').fill(dayIn(examInDays))
  await form.getByRole('button', { name: 'Save and start warm-up' }).click()
  await expect(page).toHaveURL(new RegExp(`${courseUrl}/topics/`))
}
