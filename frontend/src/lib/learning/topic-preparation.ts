import { prisma } from '@/lib/db/prisma'
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs/active-jobs'

/**
 * What a topic is prepared with, in the order a student meets it (the AI service keeps the same
 * list: ai-service/app/services/generation_chain.py CONTENT_ORDER).
 */
export const PREPARATION_ORDER = [
  'concepts',
  'warmup',
  'section_notes',
  'solved_examples',
  'interactive_examples',
  'topic_quiz',
] as const

export type PreparationType = (typeof PREPARATION_ORDER)[number]

/** The first type of PREPARATION_ORDER the topic does not have, or null when it has them all. */
export function firstMissing(present: ReadonlySet<string>): PreparationType | null {
  return PREPARATION_ORDER.find((type) => !present.has(type)) ?? null
}

const conceptsExtracted = async (topicId: string): Promise<boolean> => {
  if ((await prisma.concept.count({ where: { topicId, status: 'active' } })) > 0) return true
  // An extraction that finished with no concept is not asked for again on every visit.
  const finished = await prisma.processingJob.count({
    where: {
      jobType: 'generate_content',
      status: 'completed',
      AND: [
        { inputData: { path: ['topicId'], equals: topicId } },
        { inputData: { path: ['contentType'], equals: 'concepts' } },
      ],
    },
  })
  return finished > 0
}

/** Whether the topic has this type: concepts, the warm-up bank, or a topic_content row. */
export async function hasContentOfType(topicId: string, contentType: string): Promise<boolean> {
  if (contentType === 'concepts') return conceptsExtracted(topicId)
  if (contentType === 'warmup') return (await prisma.topicQuiz.count({ where: { topicId, kind: 'warmup' } })) > 0
  return (await prisma.topicContent.count({ where: { topicId, contentType } })) > 0
}

/**
 * The concepts job running or queued for the topic, whichever chain started it. A "prepare
 * concepts" chain's first job has the target concepts:<projectId>, not the topic's own content
 * target, so the target key cannot tell.
 */
export async function findActiveConceptsJob(topicId: string): Promise<{ id: string; status: string } | null> {
  return prisma.processingJob.findFirst({
    where: {
      jobType: 'generate_content',
      status: { in: ACTIVE_JOB_STATUSES },
      AND: [
        { inputData: { path: ['topicId'], equals: topicId } },
        { inputData: { path: ['contentType'], equals: 'concepts' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  })
}

/** How long after a preparation job finishes the next one of the chain is still expected (the AI service queues it a moment later). */
const CHAIN_GAP_MS = 20_000

/**
 * Whether the topic's preparation (concepts, warm-up, notes) is under way: a job of it is pending or running, or one finished
 * a moment ago and the next of the chain has not been queued yet. Any generate_content job for the topic counts, whichever
 * chain started it, so the gap between two jobs does not read as "finished".
 */
export async function preparationInFlight(topicId: string, now: Date = new Date()): Promise<boolean> {
  const job = await prisma.processingJob.findFirst({
    where: {
      jobType: 'generate_content',
      inputData: { path: ['topicId'], equals: topicId },
      OR: [{ status: { in: ACTIVE_JOB_STATUSES } }, { status: 'completed', completedAt: { gte: new Date(now.getTime() - CHAIN_GAP_MS) } }],
    },
    select: { id: true },
  })
  return job !== null
}

export type RequestedContent =
  | { kind: 'active'; jobId: string; status: string }
  | { kind: 'exists' }
  | { kind: 'start'; contentType: string; replacing: boolean }

/**
 * What a generate-content request does. A concepts job already running for the topic is followed
 * instead of started again. With `onlyIfMissing`, a type the topic has is not started; opening a
 * topic (`prepareRest`) goes on with the first type it is missing.
 */
export async function resolveRequestedContent(input: {
  topicId: string
  contentType: string
  onlyIfMissing: boolean
  prepareRest: boolean
}): Promise<RequestedContent> {
  if (input.contentType === 'concepts') {
    const active = await findActiveConceptsJob(input.topicId)
    if (active) return { kind: 'active', jobId: active.id, status: active.status }
  }
  const present = await hasContentOfType(input.topicId, input.contentType)
  if (!(input.onlyIfMissing && present)) return { kind: 'start', contentType: input.contentType, replacing: present }
  const next = input.prepareRest ? await firstMissingContentType(input.topicId) : null
  return next ? { kind: 'start', contentType: next, replacing: false } : { kind: 'exists' }
}

/** The first type the topic is missing, looking at stored content only. */
export async function firstMissingContentType(topicId: string): Promise<PreparationType | null> {
  const present = new Set<string>()
  for (const type of PREPARATION_ORDER) {
    if (await hasContentOfType(topicId, type)) present.add(type)
  }
  return firstMissing(present)
}
