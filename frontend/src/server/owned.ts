/**
 * Who owns what, asked once (SEC-L1).
 *
 * An id in a URL, a body or a stored row says nothing about whose it is. A helper that reads or writes by a bare id
 * is safe only while every caller remembers to check first, and one that forgets reads another student's data. So the
 * check lives here, and its answer is a branded value: an `OwnedTopic` can only be made by `ownedTopic`, so a function
 * that takes one cannot be called with an id nobody checked (the compiler refuses a plain `{ id }`).
 *
 *   const topic = await ownedTopic(session.user.id, topicId)
 *   if (!topic) return apiNotFound('Topic not found')     // not yours and missing are the same answer
 *   await loadRecallConcepts(topic)
 *
 * Every helper filters through the course's owner in the query itself. `tests/cross-user` (src/app/api/cross-user.db.test.ts)
 * calls every route with another student's ids and expects 404.
 */
import { prisma } from '@/lib/db/prisma'

declare const brand: unique symbol
type Owned<Kind extends string, T> = T & { readonly [brand]: Kind }

// Only this module creates these, after the query has filtered by the user.
const owned = <Kind extends string, T>(value: T): Owned<Kind, T> => value as Owned<Kind, T>

export type OwnedProject = Owned<'project', { id: string }>
export type OwnedTopic = Owned<'topic', { id: string; projectId: string; name: string }>
export type OwnedUnit = Owned<'unit', { id: string; projectId: string }>
export type OwnedMaterial = Owned<'material', { id: string; projectId: string }>
export type OwnedThread = Owned<'thread', { id: string; projectId: string; title: string | null }>
export type OwnedVoiceSession = Owned<'voiceSession', { id: string; projectId: string; topicId: string | null }>
export type OwnedExam = Owned<'exam', { id: string; projectId: string; durationMinutes: number }>
export type OwnedConcept = Owned<'concept', { id: string; topicId: string }>
export type OwnedMessage = Owned<
  'message',
  { id: string; threadId: string; projectId: string; role: string; tutor: unknown }
>

export async function ownedProject(userId: string, projectId: string): Promise<OwnedProject | null> {
  const project = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })
  return project && owned<'project', { id: string }>(project)
}

/** The student's topic; with `projectId`, only when it is in that course. */
export async function ownedTopic(userId: string, topicId: string, projectId?: string): Promise<OwnedTopic | null> {
  const topic = await prisma.topic.findFirst({
    where: { id: topicId, project: { userId }, ...(projectId ? { projectId } : {}) },
    select: { id: true, projectId: true, name: true },
  })
  return topic && owned<'topic', { id: string; projectId: string; name: string }>(topic)
}

/** Those of `topicIds` that are the student's, in the order given (an id that is not theirs is left out). */
export async function ownedTopics(userId: string, topicIds: readonly string[]): Promise<OwnedTopic[]> {
  if (topicIds.length === 0) return []
  const found = await prisma.topic.findMany({
    where: { id: { in: [...new Set(topicIds)] }, project: { userId } },
    select: { id: true, projectId: true, name: true },
  })
  const byId = new Map(found.map((topic) => [topic.id, topic]))
  return topicIds.flatMap((id) => {
    const topic = byId.get(id)
    return topic ? [owned<'topic', { id: string; projectId: string; name: string }>(topic)] : []
  })
}

export async function ownedUnit(userId: string, unitId: string): Promise<OwnedUnit | null> {
  const unit = await prisma.unit.findFirst({
    where: { id: unitId, project: { userId } },
    select: { id: true, projectId: true },
  })
  return unit && owned<'unit', { id: string; projectId: string }>(unit)
}

export async function ownedMaterial(userId: string, materialId: string): Promise<OwnedMaterial | null> {
  const material = await prisma.material.findFirst({
    where: { id: materialId, project: { userId } },
    select: { id: true, projectId: true },
  })
  return material && owned<'material', { id: string; projectId: string }>(material)
}

/** The student's conversation; with `projectId`, only when it is in that course. */
export async function ownedThread(userId: string, threadId: string, projectId?: string): Promise<OwnedThread | null> {
  const thread = await prisma.chatThread.findFirst({
    where: { id: threadId, userId, ...(projectId ? { projectId } : {}) },
    select: { id: true, projectId: true, title: true },
  })
  return thread && owned<'thread', { id: string; projectId: string; title: string | null }>(thread)
}

export async function ownedVoiceSession(userId: string, sessionId: string): Promise<OwnedVoiceSession | null> {
  const session = await prisma.voiceDrillSession.findFirst({
    where: { id: sessionId, userId, project: { userId } },
    select: { id: true, projectId: true, topicId: true },
  })
  return session && owned<'voiceSession', { id: string; projectId: string; topicId: string | null }>(session)
}

/** The mock exam, when it is in one of the student's courses. */
export async function ownedExam(userId: string, examId: string): Promise<OwnedExam | null> {
  const exam = await prisma.sampleExam.findFirst({
    where: { id: examId, project: { userId } },
    select: { id: true, projectId: true, durationMinutes: true },
  })
  return exam && owned<'exam', { id: string; projectId: string; durationMinutes: number }>(exam)
}

/** Those of `ids` that are the student's active concepts in the course, in the order given. */
export async function ownedConcepts(userId: string, projectId: string, ids: readonly string[]): Promise<OwnedConcept[]> {
  if (ids.length === 0) return []
  const found = await prisma.concept.findMany({
    where: { id: { in: [...ids] }, projectId, status: 'active', project: { userId } },
    select: { id: true, topicId: true },
  })
  const byId = new Map(found.map((concept) => [concept.id, concept]))
  return ids.flatMap((id) => {
    const concept = byId.get(id)
    return concept ? [owned<'concept', { id: string; topicId: string }>(concept)] : []
  })
}

/** A message of one of the student's conversations (`role` narrows it, e.g. the assistant's card). */
export async function ownedMessage(userId: string, messageId: string, role?: string): Promise<OwnedMessage | null> {
  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, ...(role ? { role } : {}), thread: { userId } },
    select: { id: true, threadId: true, role: true, tutor: true, thread: { select: { projectId: true } } },
  })
  if (!message) return null
  return owned<'message', { id: string; threadId: string; projectId: string; role: string; tutor: unknown }>({
    id: message.id,
    threadId: message.threadId,
    projectId: message.thread.projectId,
    role: message.role,
    tutor: message.tutor,
  })
}
