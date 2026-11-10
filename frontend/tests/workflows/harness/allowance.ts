import { withPrisma } from '../../e2e/helpers/db'

/** The AI service's daily limit per student, in dollars (config.py DAILY_LLM_BUDGET_USD); the workflow stack keeps the default. */
export const DAILY_LIMIT_USD = Number(process.env.DAILY_LLM_BUDGET_USD ?? 8)

/** The next midnight UTC, when every student's allowance starts again. */
function nextResetUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

/** Minutes until the allowance resets at midnight UTC: a run that crosses it starts the day's spend again from nothing. */
export function minutesToReset(now = new Date()): number {
  return (nextResetUtc(now).getTime() - now.getTime()) / 60_000
}

/**
 * K4's overshoot once a day's work is done: how far the spend went past the limit, and whether that is more than the
 * costliest single job. Jobs checked one at a time stop at most one job past the limit; jobs started together each
 * pass the check before any of them is counted (S2 bounds this).
 */
export function overshoot(spentBefore: number, costs: readonly number[], limit: number): { over: number; moreThanOneJob: boolean } {
  const over = Math.max(0, spentBefore + costs.reduce((sum, cost) => sum + cost, 0) - limit)
  return { over, moreThanOneJob: over > Math.max(0, ...costs) + 1e-9 }
}

/**
 * The one "allowance reached" state every surface shows: the same sentence, and when the allowance comes back. An
 * alert may show the sentence as its title, with no full stop.
 */
const ALLOWANCE_STATE = {
  'the sentence "You\'ve used today\'s AI allowance"': /You['’]ve used today['’]s AI allowance\b/,
  'when it resets': /\bresets (tomorrow )?at \d{1,2}:\d{2}\s?[AP]M\b/i,
}

/** What a surface's text leaves out of the shared "allowance reached" state. */
export function allowanceStateGaps(text: string): string[] {
  return Object.entries(ALLOWANCE_STATE).flatMap(([part, says]) => (says.test(text) ? [] : [part]))
}

/** D2: whether an allowance summary says what is left in plain terms ("about 6 topics or 40 practice problems"), not only a percent. */
export function inPlainTerms(text: string): boolean {
  return /\b\d+\s+(more\s+)?(topics?|practice problems?|problems?|quiz(zes)?|questions?|worked examples?|answers?)\b/i.test(text)
}

async function studentId(email: string): Promise<string> {
  return withPrisma(async (prisma) => (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id)
}

/** What the student has spent today, as the AI service counts it: the ledger since midnight UTC. */
export async function spentToday(email: string): Promise<number> {
  const userId = await studentId(email)
  const now = new Date()
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const sum = await withPrisma((prisma) => prisma.llmUsageEvent.aggregate({ where: { userId, createdAt: { gte: midnight } }, _sum: { costUsd: true } }))
  return Number(sum._sum.costUsd ?? 0)
}

/**
 * Brings the student's spend today up to `target` dollars with one ledger row, as if earlier work had cost that, and
 * returns the time after which any new row is new work. The student never does this; it stands for a day of studying.
 */
export async function spendUpTo(email: string, target: number): Promise<Date> {
  const userId = await studentId(email)
  const spent = await spentToday(email)
  return withPrisma(async (prisma) => {
    if (target > spent) {
      await prisma.llmUsageEvent.create({ data: { userId, source: 'job', sourceId: 'workflow: earlier work today', costUsd: (target - spent).toFixed(6) } })
    }
    const last = await prisma.llmUsageEvent.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
    return last?.createdAt ?? new Date()
  })
}

/**
 * The student's ledger rows after `since`, oldest first: one for each job, chat answer or voice session that called the
 * model, with the job's type when a job made it.
 */
export async function spendSince(email: string, since: Date): Promise<{ source: string; jobType: string | null; cost: number }[]> {
  const userId = await studentId(email)
  return withPrisma(async (prisma) => {
    const rows = await prisma.llmUsageEvent.findMany({
      where: { userId, createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
      select: { source: true, sourceId: true, costUsd: true },
    })
    const ids = rows.flatMap((row) => (row.source === 'job' && row.sourceId && /^[0-9a-f-]{36}$/.test(row.sourceId) ? [row.sourceId] : []))
    const jobs = await prisma.processingJob.findMany({ where: { id: { in: ids } }, select: { id: true, jobType: true } })
    const typeOf = new Map(jobs.map((job) => [job.id, job.jobType]))
    return rows.map((row) => ({ source: row.source, jobType: (row.sourceId && typeOf.get(row.sourceId)) || null, cost: Number(row.costUsd) }))
  })
}

/** How long a topic opened in the app gets to start its first content job before it counts as refused. */
const START_WINDOW_MS = 60_000

/**
 * Whether the content jobs for topics opened together are done: every topic has started one (or a minute has gone by,
 * so the rest were refused before any job) and none still waits or runs.
 */
export function jobsSettled({ asked, started, running, waitedMs }: { asked: number; started: number; running: number; waitedMs: number }): boolean {
  return running === 0 && (started >= asked || waitedMs > START_WINDOW_MS)
}

/**
 * Waits until the topics opened at `since` have each started their content jobs and none still waits or runs: each has
 * written what it could, or been refused. A page asks for its preparation a moment after it loads.
 */
export async function topicJobsSettled(topicIds: readonly string[], since: Date, timeout = 5 * 60_000): Promise<void> {
  const began = Date.now()
  const forTopics = { jobType: 'generate_content', OR: topicIds.map((topicId) => ({ inputData: { path: ['topicId'], equals: topicId } })) }
  for (;;) {
    const [running, jobs] = await withPrisma((prisma) =>
      Promise.all([
        prisma.processingJob.count({ where: { ...forTopics, status: { in: ['pending', 'processing'] } } }),
        prisma.processingJob.findMany({ where: { ...forTopics, createdAt: { gte: since } }, select: { inputData: true } }),
      ])
    )
    const started = new Set(jobs.map((job) => (job.inputData as { topicId?: string } | null)?.topicId)).size
    if (jobsSettled({ asked: topicIds.length, started, running, waitedMs: Date.now() - began })) return
    if (Date.now() - began > timeout) throw new Error(`Content jobs were still running for the topics after ${timeout / 1000} s`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
