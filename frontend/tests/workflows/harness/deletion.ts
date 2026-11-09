import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { withPrisma } from '../../e2e/helpers/db'

/**
 * WF12: what deleting a course or an account leaves behind, in storage and in the database, and how its dialog asks.
 */

/**
 * The instructions the two delete dialogs give: the course's asks for its name to be typed; the account's for the
 * confirmation word, which stays in capitals (the verb may not: "Enter" in a sentence, "enter" in one).
 */
export const INSTRUCTIONS = {
  typeTheName: /\btype the (course(?:'s)? )?name\b/i,
  enterDelete: /\b(?:[Ee]nter|[Tt]ype)\s+DELETE\b/,
} as const

/**
 * Every piece of text in `region`, with a space between pieces (textContent runs "Confirmation" and "Enter" together),
 * the text read out only to screen readers included.
 */
export async function allText(region: Locator): Promise<string> {
  const text = await region.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const pieces: string[] = []
    while (walker.nextNode()) pieces.push(walker.currentNode.textContent ?? '')
    return pieces.join(' ')
  })
  return text.replace(/\s+/g, ' ').trim()
}

/** How many times `text` gives the instruction `instruction` matches (U4, SW15). The pattern is read as global. */
export function timesSaid(text: string, instruction: RegExp): number {
  const global = new RegExp(instruction.source, instruction.flags.includes('g') ? instruction.flags : `${instruction.flags}g`)
  return [...text.matchAll(global)].length
}

/** Every file under `dir`, relative to it; nothing when the folder is gone. */
export function filesLeft(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => statSync(path.join(dir, name)).isFile())
    .map((name) => name.split(path.sep).join('/'))
}

/** The paths that hold one of `ids`. */
export function pathsNaming(paths: string[], ids: string[]): string[] {
  return paths.filter((file) => ids.some((id) => file.includes(id)))
}

/** The stack's local storage (scripts/e2e-stack.sh: LOCAL_UPLOADS_DIR=$E2E_RUN_DIR/uploads). */
export function uploadsDir(): string {
  const dir = process.env.E2E_RUN_DIR
  if (!dir) throw new Error("Set E2E_RUN_DIR to the stack's run folder (scripts/e2e-stack.sh)")
  return path.join(dir, 'uploads')
}

/** Where B8 stores a page image: in the file's own folder, under pages/, so deleting the file's folder takes them. */
export function pageImagePath(uploads: string, userId: string, courseId: string, materialId: string, page: number): string {
  return path.join(uploads, userId, courseId, 'materials', materialId, 'pages', `${String(page).padStart(4, '0')}.webp`)
}

/** Puts a page image where B8 will store one, so a deletion is checked on page images before B8 writes any. */
export function plantPageImage(userId: string, courseId: string, materialId: string, page = 1): string {
  const file = pageImagePath(uploadsDir(), userId, courseId, materialId, page)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'RIFF....WEBP')
  return file
}

/**
 * The ids a course owns, read before it is deleted: the course, its files and their chunks, its units, topics and
 * their content and quizzes, concepts, Ask conversations and their messages, voice sessions, exams, quizzes over the
 * course, study sessions and jobs. A row elsewhere that names any of them after the delete is a reference left behind.
 */
export async function courseIds(courseId: string): Promise<string[]> {
  return withPrisma(async (prisma) => {
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id)
    const byCourse = { where: { projectId: courseId }, select: { id: true } } as const
    const materials = ids(await prisma.material.findMany(byCourse))
    const topics = ids(await prisma.topic.findMany(byCourse))
    const threads = ids(await prisma.chatThread.findMany(byCourse))
    return [
      courseId,
      ...materials,
      ...ids(await prisma.materialChunk.findMany({ where: { materialId: { in: materials } }, select: { id: true } })),
      ...topics,
      ...ids(await prisma.unit.findMany(byCourse)),
      ...ids(await prisma.topicContent.findMany({ where: { topicId: { in: topics } }, select: { id: true } })),
      ...ids(await prisma.topicQuiz.findMany({ where: { topicId: { in: topics } }, select: { id: true } })),
      ...ids(await prisma.concept.findMany(byCourse)),
      ...threads,
      ...ids(await prisma.chatMessage.findMany({ where: { threadId: { in: threads } }, select: { id: true } })),
      ...ids(await prisma.voiceDrillSession.findMany(byCourse)),
      ...ids(await prisma.sampleExam.findMany(byCourse)),
      ...ids(await prisma.overallQuiz.findMany(byCourse)),
      ...ids(await prisma.itemSession.findMany(byCourse)),
      ...ids(await prisma.processingJob.findMany(byCourse)),
    ]
  })
}

/**
 * The tables with a row that names any of `needles` anywhere (any column, JSON and arrays included: the whole row as
 * text), with how many rows; the tables in `except` are left out. Empty when nothing names them.
 */
export async function rowsNaming(needles: string[], except: string[] = []): Promise<string[]> {
  const patterns = needles.filter(Boolean).map((needle) => `%${needle}%`)
  if (patterns.length === 0) return []
  return withPrisma(async (prisma) => {
    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
      ORDER BY table_name`
    const found: string[] = []
    for (const { name } of tables) {
      if (except.includes(name)) continue
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${name.replace(/"/g, '""')}" t WHERE t::text LIKE ANY($1::text[])`,
        patterns
      )
      if (n > 0) found.push(`${name}: ${n} row${n === 1 ? '' : 's'}`)
    }
    return found
  })
}

/** Today's spend (UTC day) in the ledger: one student's, or everyone's. Deleting must never lower it. */
export async function spendToday(userId?: string): Promise<number> {
  return withPrisma(async (prisma) => {
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    const sum = await prisma.llmUsageEvent.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: start }, ...(userId ? { userId } : {}) } })
    return Number(sum._sum.costUsd ?? 0)
  })
}

/** Waits until the AI service has written nothing to its log for `quietMs` (at most `timeout`): work in flight has ended. */
export async function aiServiceQuiet(quietMs = 5000, timeout = 90_000): Promise<void> {
  const log = path.join(path.dirname(uploadsDir()), 'ai.log')
  const deadline = Date.now() + timeout
  let size = existsSync(log) ? statSync(log).size : 0
  let since = Date.now()
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const now = existsSync(log) ? statSync(log).size : 0
    if (now !== size) {
      size = now
      since = Date.now()
    } else if (Date.now() - since >= quietMs) return
  }
  throw new Error(`The AI service was still writing to ${log} after ${timeout / 1000} s`)
}
