/**
 * After a file is deleted, ideas that lost every claim "need re-reading". For each topic that has such ideas and still has
 * text to read, one `requote_concepts` job asks the AI service to find new quotes for them (same concept ids) in the
 * topic's remaining sources. It is not the student's request, so it stays out of the daily request count; whether it does
 * anything is the AI service's flag. Best effort: the delete has already happened.
 */

import { prisma } from '@/lib/db/prisma'
import { requoteConceptsTarget } from '@/lib/jobs/active-jobs'
import { startBackgroundJob } from '@/lib/jobs/start-job'
import { needsRereadingWhere } from '@/lib/learning/needs-rereading'

/** Topic ids of the course that have an idea needing re-reading and some text left to find quotes in. */
export async function topicsToRequote(projectId: string): Promise<string[]> {
  const rows = await prisma.concept.findMany({
    where: {
      projectId,
      ...needsRereadingWhere,
      topic: { OR: [{ sources: { some: {} } }, { topicChunkMappings: { some: {} } }] },
    },
    distinct: ['topicId'],
    select: { topicId: true },
  })
  return rows.map((row) => row.topicId)
}

/** Starts one job per topic found; returns how many were started or already running. */
export async function startRequoteJobs(userId: string, projectId: string): Promise<number> {
  const topicIds = await topicsToRequote(projectId)
  let started = 0
  for (const topicId of topicIds) {
    const job = await startBackgroundJob({
      userId,
      projectId,
      jobType: 'requote_concepts',
      endpoint: '/jobs/requote-concepts',
      data: { topicId, projectId },
      targetKey: requoteConceptsTarget(topicId),
      stage: 'generating',
    })
    if (job) started += 1
  }
  return started
}
