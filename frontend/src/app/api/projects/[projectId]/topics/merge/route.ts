/**
 * POST /api/projects/[projectId]/topics/merge
 * Merge one topic (the source) into another (the target). The source is deleted.
 * The rule for every table that names a topic is in lib/topics/topic-references.ts.
 *
 * What moves to the target:
 *  - chunk mappings (a chunk both topics map to keeps the higher relevance score)
 *  - generated content of a type the target does not have, and all quiz sets
 *  - quiz attempts, learning signals and voice sessions and attempts
 *  - the student's own work: margin notes, recall attempts, practice progress and unsent drafts (a draft or reader
 *    tutor state whose key starts with the source's id is renamed; if the target has one at the same key, the target's stays)
 *  - concepts with their claims, memory and evidence, so concept mastery and review dates survive; the target's
 *    mastery and review date are then worked out again from them
 *  - progress (checkmarks are OR-ed, the best quiz score is kept) and the review schedule
 *    (the target's own is kept when both have one)
 *  - course structure: the source's sources (topic_sources) go to the target, objectives are
 *    joined (at most 8), the estimated minutes add up, prerequisites are joined, and other topics
 *    that had the source as a prerequisite now point at the target. The target keeps its unit.
 * Not carried over: the source's voice drill question cache. Practice progress on a practice set the target replaced stays
 * as history. The target keeps its own generated content, since it may now be out of date against the
 * merged chunks; regenerate it from the topic page if needed.
 */

import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { id, list, record } from '@/lib/api/fields'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { mergeKeywordLists } from '@/lib/topics/ordering'
import { moveTopicReferences } from '@/lib/topics/topic-references'
import { recomputeTopicFromConcepts } from '@/lib/learning/mastery'
import { ownedTopics } from '@/server/owned'
import { normalizeTopicOrder } from '@/lib/topics/normalize-order'
import { reachesPrerequisite } from '@/lib/topics/units'
import {
  ApiErrorCode,
  apiError,
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

const mergeSchema = z.object({
  sourceTopicId: id(),
  targetTopicId: id(),
  name: z.string().trim().min(1).max(255).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { projectId } = await params

    const parsed = await readJson(request, mergeSchema)
    if (!parsed.ok) return parsed.response
    const { sourceTopicId, targetTopicId, name } = parsed.data
    if (sourceTopicId === targetTopicId) {
      return apiInvalidInput('Choose two different topics to merge')
    }

    // Ownership: both topics must belong to this project, and the project to this user.
    const checked = (await ownedTopics(session.user.id, [sourceTopicId, targetTopicId])).filter((topic) => topic.projectId === projectId)
    const topics = await prisma.topic.findMany({ where: { id: { in: checked.map((topic) => topic.id) } } })
    const source = topics.find((topic) => topic.id === sourceTopicId)
    const target = topics.find((topic) => topic.id === targetTopicId)
    if (!source || !target) {
      return apiNotFound('Topic not found')
    }

    const merged = await prisma.$transaction(async (tx) => {
      const movedConceptIds = (await tx.concept.findMany({ where: { topicId: source.id }, select: { id: true } })).map((concept) => concept.id)

      // Chunk mappings.
      const [sourceMappings, targetMappings] = await Promise.all([
        tx.topicChunkMapping.findMany({ where: { topicId: source.id } }),
        tx.topicChunkMapping.findMany({ where: { topicId: target.id } }),
      ])
      const targetByChunk = new Map(targetMappings.map((mapping) => [mapping.chunkId, mapping]))
      for (const mapping of sourceMappings) {
        const existing = targetByChunk.get(mapping.chunkId)
        if (!existing) {
          await tx.topicChunkMapping.update({
            where: { id: mapping.id },
            data: { topicId: target.id },
          })
        } else if (mapping.relevanceScore > existing.relevanceScore) {
          await tx.topicChunkMapping.update({
            where: { id: existing.id },
            data: {
              relevanceScore: mapping.relevanceScore,
              relevanceSource: mapping.relevanceSource,
            },
          })
        }
      }

      // Generated content and quiz sets.
      const targetContent = await tx.topicContent.findMany({
        where: { topicId: target.id },
        select: { contentType: true },
      })
      await tx.topicContent.updateMany({
        where: {
          topicId: source.id,
          contentType: { notIn: targetContent.map((item) => item.contentType) },
        },
        data: { topicId: target.id },
      })

      // Everything else that names the topic and is not handled below (quizzes, learning history, notes, recall,
      // practice progress, drafts, concepts with their memory and evidence, tutor state): the registry's 'move' rules.
      await moveTopicReferences({ tx, userId: session.user.id, sourceId: source.id, targetId: target.id })

      // Progress: one row per user and topic.
      const sourceProgress = await tx.topicProgress.findMany({ where: { topicId: source.id } })
      for (const row of sourceProgress) {
        const existing = await tx.topicProgress.findUnique({
          where: { topicId_userId: { topicId: target.id, userId: row.userId } },
        })
        if (!existing) {
          await tx.topicProgress.update({ where: { id: row.id }, data: { topicId: target.id } })
        } else {
          const scores = [existing.quizScore, row.quizScore].filter(
            (score): score is number => typeof score === 'number'
          )
          await tx.topicProgress.update({
            where: { id: existing.id },
            data: {
              notesCompleted: existing.notesCompleted || row.notesCompleted,
              notesCompletedAt: [existing.notesCompletedAt, row.notesCompletedAt].filter((date): date is Date => date !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
              examplesCompleted: existing.examplesCompleted || row.examplesCompleted,
              quizCompleted: existing.quizCompleted || row.quizCompleted,
              quizScore: scores.length > 0 ? Math.max(...scores) : null,
            },
          })
        }
      }

      // Review schedule: one row per user and topic. The target's wins.
      const sourceSchedules = await tx.reviewSchedule.findMany({ where: { topicId: source.id } })
      for (const row of sourceSchedules) {
        const existing = await tx.reviewSchedule.findUnique({
          where: { userId_topicId: { userId: row.userId, topicId: target.id } },
        })
        if (!existing) {
          await tx.reviewSchedule.update({ where: { id: row.id }, data: { topicId: target.id } })
        }
      }

      // Course structure: the sections the source was taught from, objectives, minutes.
      const objectives = Array.from(new Set([...(target.objectives ?? []), ...(source.objectives ?? [])])).slice(0, 8)
      const minutes =
        target.estimatedMinutes !== null || source.estimatedMinutes !== null
          ? Math.min((target.estimatedMinutes ?? 0) + (source.estimatedMinutes ?? 0), 180)
          : null

      // Prerequisites: the target takes the source's, and whoever depended on the source now
      // depends on the target. A link that would make a loop is dropped.
      const everyTopic = await tx.topic.findMany({
        where: { projectId },
        select: { id: true, prerequisiteIds: true },
      })
      const graph = new Map<string, string[]>()
      for (const item of everyTopic) {
        if (item.id === source.id) continue
        const own = item.id === target.id ? [...(target.prerequisiteIds ?? []), ...(source.prerequisiteIds ?? [])] : item.prerequisiteIds
        graph.set(item.id, Array.from(new Set(own.map((id) => (id === source.id ? target.id : id)))).filter((id) => id !== item.id && id !== source.id))
      }
      for (const [id, list] of graph) {
        // Drop a link from `id` to a topic that already depends (through others) on `id`.
        const kept = list.filter((other) => !reachesPrerequisite(graph, other, id))
        if (kept.length !== list.length) graph.set(id, kept)
      }
      for (const item of everyTopic) {
        if (item.id === source.id) continue
        const next = graph.get(item.id) ?? []
        const same = next.length === item.prerequisiteIds.length && next.every((id, index) => id === item.prerequisiteIds[index])
        if (!same || item.id === target.id) {
          await tx.topic.update({ where: { id: item.id }, data: { prerequisiteIds: next } })
        }
      }

      await tx.topic.update({
        where: { id: target.id },
        data: {
          name: name ?? target.name,
          description: target.description?.trim() ? target.description : source.description,
          keywords: mergeKeywordLists(target.keywords, source.keywords),
          sourceMaterialIds: Array.from(new Set([...target.sourceMaterialIds, ...source.sourceMaterialIds])),
          objectives,
          estimatedMinutes: minutes,
          // Confirmed if either side was: a new topic merged into a confirmed one must not hide it and its
          // progress, and a confirmed topic merged into a new one keeps its study history visible.
          userConfirmed: target.userConfirmed || source.userConfirmed,
        },
      })

      // The moved concepts are read through the target from now on: when the target had no concepts of its own and the
      // source's history was converted, the target is converted too. Then its mastery and review date are worked out again.
      if (!target.evidenceBackfilledAt && source.evidenceBackfilledAt && movedConceptIds.length > 0) {
        const ownConcepts = await tx.concept.count({ where: { topicId: target.id, status: 'active', id: { notIn: movedConceptIds } } })
        if (ownConcepts === 0) await tx.topic.update({ where: { id: target.id }, data: { evidenceBackfilledAt: source.evidenceBackfilledAt } })
      }
      await recomputeTopicFromConcepts(tx, session.user.id, target.id)

      // What is left on the source (its own progress and schedule rows that lost to the
      // target's) goes with it.
      await tx.topic.delete({ where: { id: source.id } })

      // Close the gap in the order.
      const remaining = await tx.topic.findMany({
        where: { projectId },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, orderIndex: true },
      })
      for (const [index, topic] of remaining.entries()) {
        if (topic.orderIndex !== index) {
          await tx.topic.update({ where: { id: topic.id }, data: { orderIndex: index } })
        }
      }
      // A merge across units can leave a unit's topics apart; keep the units contiguous.
      await normalizeTopicOrder(tx, checked[0])

      return tx.topic.findUniqueOrThrow({ where: { id: target.id } })
    })

    return NextResponse.json({ topic: merged, mergedTopicId: source.id })
  } catch (error) {
    logServerError('Merge topics error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    if (error instanceof SyntaxError) {
      return apiError(ApiErrorCode.INVALID_INPUT, 'Invalid JSON body', undefined, 400)
    }
    return apiInternal('Failed to merge topics')
  }
}
