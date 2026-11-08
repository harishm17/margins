import { execFile } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, type Locator } from '@playwright/test'
import { withPrisma } from '../../e2e/helpers/db'
import { courseFile } from './course'

/** A row of an answer's Sources list: its label ("lecture-1.pdf, p. 3"), all its text, and whether it opens the file. */
export type SourceRow = { label: string; text: string; opens: boolean }

/** The sources that cite `filename`: their label is the file name, alone or before its place ("lecture-1.pdf, p. 3"). */
export function citing(rows: readonly SourceRow[], filename: string): SourceRow[] {
  return rows.filter((row) => row.label === filename || row.label.startsWith(`${filename}, `))
}

/** F5: each source citing the removed `filename` that still offers to open it, or does not say its source was removed. */
export function deadCitations(rows: readonly SourceRow[], filename: string): string[] {
  return citing(rows, filename).flatMap((row) => [
    ...(row.opens ? [`${row.label}: still opens the file`] : []),
    ...(/source removed/i.test(row.text) ? [] : [`${row.label}: does not say "source removed"`]),
  ])
}

/** The name a browser gives a second download of a file: "lecture-2.pdf" becomes "lecture-2 (1).pdf". */
export function renamedCopyName(name: string): string {
  const { name: stem, ext } = path.parse(name)
  return `${stem} (1)${ext}`
}

/** Adds a margin note on the first passage the reader shows in `scope` (the reader, or one file's section of it); returns the passage's name ("passage 3"). */
export async function addMarginNote(scope: Locator, text: string): Promise<string> {
  const add = scope.getByRole('button', { name: /^Add a note on passage \d+$/ }).first()
  await expect(add).toBeVisible({ timeout: 60_000 })
  const passage = ((await add.getAttribute('aria-label')) ?? '').replace(/^Add a note on /, '')
  await add.click()
  await scope.getByLabel(`Your note on ${passage}`).fill(text)
  await scope.getByRole('button', { name: 'Save note' }).click()
  await expect(scope.getByRole('list', { name: `Notes on ${passage}` })).toContainText(text)
  return passage
}

/** The rows of a reply's Sources list, opened first (it starts closed behind "n sources"). */
export async function sourceRows(reply: Locator): Promise<SourceRow[]> {
  const section = reply.getByRole('region', { name: 'Sources' })
  if (!(await section.count())) return []
  const toggle = section.getByRole('button', { name: /^\d+ sources?$/ })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  return section.getByRole('listitem').evaluateAll((items) =>
    items.map((item) => ({
      label: (item.querySelector('[title]')?.getAttribute('title') ?? '').trim(),
      text: (item.textContent ?? '').replace(/\s+/g, ' ').trim(),
      opens: [...item.querySelectorAll('a, button')].some((control) => /Open page|View excerpt/.test(control.textContent ?? '')),
    }))
  )
}

/**
 * The same file under the name a browser gives a second download, in this test's output folder: same bytes, new name,
 * so only a check of the content can tell it is already in the course (F1, finding 73).
 */
export async function renamedCopy(name: string, outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true })
  const copy = path.join(outputDir, renamedCopyName(name))
  await copyFile(courseFile(name), copy)
  return copy
}

/**
 * Waits until the topic's preparation has run to its end in the background: concepts through the quiz, one job after
 * another (generation_chain.py CONTENT_ORDER). Each job reads the topic's files when it starts, so a file deleted or
 * replaced while the chain still runs changes what later jobs read, and the recorded answers stop matching.
 */
export async function preparationFinished(topicId: string, timeout = 6 * 60_000): Promise<void> {
  const forTopic = { inputData: { path: ['topicId'], equals: topicId } }
  const deadline = Date.now() + timeout
  for (;;) {
    const [running, quizzes] = await withPrisma((prisma) =>
      Promise.all([
        prisma.processingJob.count({ where: { jobType: 'generate_content', status: { in: ['pending', 'processing'] }, ...forTopic } }),
        prisma.processingJob.count({
          where: { jobType: 'generate_content', status: 'completed', AND: [forTopic, { inputData: { path: ['contentType'], equals: 'topic_quiz' } }] },
        }),
      ])
    )
    if (running === 0 && quizzes > 0) return
    if (Date.now() > deadline) throw new Error(`The topic's preparation had not finished after ${timeout / 1000} s`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

/** The topic's ideas left with no claim: recall, quick checks and "look again" pointers read claims (K38, SW13). */
export async function ideasWithoutClaims(topicId: string): Promise<string[]> {
  return withPrisma(async (prisma) => {
    const ideas = await prisma.concept.findMany({
      where: { topicId, status: 'active', claims: { none: {} } },
      select: { name: true },
      orderBy: { orderIndex: 'asc' },
    })
    return ideas.map((idea) => idea.name)
  })
}

/** How many claims the topic's ideas hold. */
export async function claimCount(topicId: string): Promise<number> {
  return withPrisma((prisma) => prisma.conceptClaim.count({ where: { concept: { topicId, status: 'active' } } }))
}

/**
 * The state an earlier Replace or Delete left topics in before F0 (finding 89): their ideas kept, every claim gone. The
 * student never does this; the workflow sets it up so the one-off repair has something to repair.
 */
export async function loseClaims(topicId: string): Promise<number> {
  return withPrisma(async (prisma) => (await prisma.conceptClaim.deleteMany({ where: { concept: { topicId } } })).count)
}

const run = promisify(execFile)

/**
 * F0's one-off repair, as an operator runs it: a dry run that lists the ideas it would re-read, then the run that
 * re-reads them. It runs on the workflow's database with the stack's model settings, so its model calls are replayed
 * or recorded like the app's. Until F0 adds the script, it reports that there is none.
 */
export async function repairLostClaims(courseId: string): Promise<{ ran: boolean; output: string }> {
  const service = path.join(process.cwd(), '..', 'ai-service')
  const script = 'scripts/repair_lost_claims.py'
  if (!existsSync(path.join(service, script))) return { ran: false, output: `no ${script} yet (F0)` }
  const env = {
    ...process.env,
    LLM_PROVIDER: 'replay',
    LLM_CASSETTE_DIR: process.env.E2E_CASSETTE_DIR ?? '',
    LLM_REPLAY_MISS: process.env.E2E_REPLAY_MISS ?? 'error',
  }
  const options = { cwd: service, env, timeout: 5 * 60_000 }
  const dry = await run('uv', ['run', 'python', script, '--project', courseId, '--dry-run'], options)
  const applied = await run('uv', ['run', 'python', script, '--project', courseId], options)
  return { ran: true, output: `${dry.stdout}\n${applied.stdout}` }
}
