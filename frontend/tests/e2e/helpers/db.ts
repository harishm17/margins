import { PrismaClient } from '@prisma/client'

/** The database the stack under test uses. DATABASE_URL must be set: no default, so a spec can never
 * write into somebody else's database by accident. */
export const e2eDatabaseUrl = () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Set DATABASE_URL to the database of the stack under test')
  return url
}

/** Runs `run` with a Prisma client on the stack's database, and disconnects afterwards. */
export async function withPrisma<T>(run: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ datasourceUrl: e2eDatabaseUrl(), log: [] })
  try {
    return await run(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * The simulated outage is over: the shared AI status clears and the waiting grading job is made due now, so the
 * AI service's reaper (every 5 s in the e2e stack) sends it again on its next tick instead of after its 30 s
 * recheck. It repeats until the job has left the waiting state, so a stray write to the shared status by other
 * work, or a dispatch that was lost (which would cost the job's 120 s lease), costs a few seconds and not the test.
 * It logs a warning whenever it had to clear or nudge a second time, so a recurrence is visible in the run output.
 */
export async function endOutage(targetKey: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (let round = 1; ; round++) {
    const waiting = await withPrisma(async (prisma) => {
      const cleared = await prisma.aiStatus.deleteMany({})
      // The first clear is the outage ending; a later one means something else marked the AI unavailable again.
      if (round > 1 && cleared.count > 0) console.warn(`[endOutage] ${targetKey}: the AI status was marked unavailable again and was cleared again (round ${round})`)
      const job = await prisma.processingJob.findFirstOrThrow({ where: { targetKey }, select: { status: true, stage: true } })
      // Waiting for the AI is stage waiting_for_ai on a pending job, for exam and quiz grading alike.
      if (job.status !== 'pending' || job.stage !== 'waiting_for_ai') return false
      await prisma.processingJob.updateMany({
        where: { targetKey, status: 'pending', stage: 'waiting_for_ai' },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      })
      if (round > 1) console.warn(`[endOutage] ${targetKey}: still waiting after ${round - 1} nudge(s) of the reaper; made it due again`)
      return true
    })
    if (!waiting) return
    if (Date.now() > deadline) throw new Error(`The reaper did not pick up ${targetKey} within ${timeoutMs} ms of the outage ending`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

/** Marks the shared AI status unavailable, as an outage would. Pair it with `markAiAvailable` in afterEach so no other spec sees it. */
export const markAiUnavailable = () =>
  withPrisma((prisma) => {
    const now = new Date()
    const row = { state: 'unavailable', reason: 'LLM_CREDIT_EXHAUSTED', since: now, checkedAt: now, detail: 'e2e' }
    return prisma.aiStatus.upsert({ where: { id: 'global' }, create: { id: 'global', ...row }, update: row })
  })

export const markAiAvailable = () => withPrisma((prisma) => prisma.aiStatus.deleteMany({}))
