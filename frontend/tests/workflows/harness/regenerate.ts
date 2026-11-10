import { withPrisma } from '../../e2e/helpers/db'

/** What a dialog that starts AI work must say besides what changes (SW8; the time and the share are D1 with X4). */
export type DialogPart = 'what is kept' | 'how long' | 'share of today'

const SAYS: Record<DialogPart, RegExp> = {
  'what is kept': /\b(kept|keeps?|stays?|remains?)\b/i,
  'how long': /\b(about|under|up to) \d+ (seconds?|minutes?)\b|\b\d+ (sec|min)\b/i,
  'share of today': /\d+\s?%[^.]*\b(today|daily|allowance)/i,
}

/** The parts a dialog's text leaves out, in the order a dialog says them. */
export function missingParts(text: string): DialogPart[] {
  return (Object.keys(SAYS) as DialogPart[]).filter((part) => !SAYS[part].test(text))
}

/**
 * SW10's rule for a draft once its content is regenerated: kept with an item that survives, cleared with one that does
 * not. Work shown again under an item that changed is the student's work for something else.
 */
export function inheritedWork(before: { item: string; work: string }, after: { item: string; work: string }): boolean {
  return before.work !== '' && after.work === before.work && after.item !== before.item
}

/**
 * Waits until the regenerate started at `since` has written the topic's `contentType` and nothing for the topic still
 * runs. A regenerate that failed stops the wait at once, with its error code.
 */
export async function regenerated(topicId: string, contentType: string, since: Date, timeout = 5 * 60_000): Promise<void> {
  const forTopic = { inputData: { path: ['topicId'], equals: topicId } }
  const started = { jobType: 'generate_content', createdAt: { gte: since }, AND: [forTopic, { inputData: { path: ['contentType'], equals: contentType } }] }
  const deadline = Date.now() + timeout
  for (;;) {
    const [running, done, failed] = await withPrisma((prisma) =>
      Promise.all([
        prisma.processingJob.count({ where: { jobType: 'generate_content', status: { in: ['pending', 'processing'] }, ...forTopic } }),
        prisma.processingJob.count({ where: { ...started, status: 'completed' } }),
        prisma.processingJob.findFirst({ where: { ...started, status: 'failed' }, select: { errorCode: true } }),
      ])
    )
    if (running === 0 && done > 0) return
    if (running === 0 && failed) throw new Error(`The ${contentType} regenerate failed (${failed.errorCode ?? 'no error code'})`)
    if (Date.now() > deadline) throw new Error(`No new ${contentType} for the topic after ${timeout / 1000} s`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

/** The keys of the student's saved drafts on one surface ("quiz", "practice", ...). The student never sees them. */
export async function draftKeys(email: string, surface: string): Promise<string[]> {
  return withPrisma(async (prisma) => {
    const drafts = await prisma.studyDraft.findMany({ where: { user: { email }, surface }, select: { scopeKey: true }, orderBy: { scopeKey: 'asc' } })
    return drafts.map((draft) => draft.scopeKey)
  })
}
