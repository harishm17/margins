/**
 * Every stored pointer to a topic, with its rule when the topic is merged into another and when it is deleted
 * (finding 78). The merge route and the delete route run these rules, and
 * `topic-references.test.ts` reads `prisma/schema.prisma` and fails when a model with a topic column, a topic
 * array or a scope key has no entry here, or when an entry's delete rule disagrees with the schema's `onDelete`.
 *
 * Merge rules
 *  - 'move'    the rows go to the target topic (`apply` does it; a unique key that would collide is named in `note`).
 *  - 'route'   the merge route has its own code for the table (it needs the field-by-field rules of the course
 *              structure: chunk mappings, content, progress, review schedule, prerequisites).
 *  - 'none'    not rewritten, with the reason in `note` (history, or ids that readers already treat as unknown).
 *  - 'drop'    the rows are derived caches of the source topic and go with it.
 * Delete rules
 *  - 'cascade' the schema deletes the rows with the topic.
 *  - 'keep'    the schema clears the topic column (`SetNull`) and the rows stay: the student's own writing (margin notes,
 *              listed under "Notes from removed topics") and the learning history that is not tied to one topic.
 *  - 'cleanup' the rows hold the topic in an array, a key or JSON; `deleteTopicReferences` clears them.
 *
 * Student work is never dropped by a merge: notes, recall attempts, practice progress, drafts, concepts with their claims,
 * memory (the review dates) and evidence move to the target.
 */
import type { Prisma } from '@prisma/client'
import { parseDraftKey, topicOfKey, surfaceNamesTopic, DRAFT_SURFACES } from '@/lib/drafts/draft-contract'

type Tx = Prisma.TransactionClient

export type MergeContext = { tx: Tx; userId: string; sourceId: string; targetId: string }

export type TopicReference = {
  /** The Prisma model, as written in schema.prisma. */
  model: string
  /** The column (or array, or scope key) that names the topic. */
  column: string
  merge: 'move' | 'route' | 'drop' | 'none'
  onDelete: 'cascade' | 'keep' | 'cleanup'
  /** Runs the 'move' rule. */
  apply?: (ctx: MergeContext) => Promise<void>
  note: string
}

const move = (update: (ctx: MergeContext) => Promise<unknown>) => async (ctx: MergeContext) => {
  await update(ctx)
}

/** The topic part of a reader tutor state's key: `<topicId>:<chunkId>`. */
const readerKey = (topicId: string, chunkId: string) => `${topicId}:${chunkId}`

/** A draft key with the source topic replaced by the target, or null when the key does not name the source. */
export function rewriteDraftKey(surface: string, key: string, sourceId: string, targetId: string): string | null {
  if (!(DRAFT_SURFACES as readonly string[]).includes(surface)) return null
  const draftSurface = surface as (typeof DRAFT_SURFACES)[number]
  if (surfaceNamesTopic(draftSurface)) {
    if (topicOfKey(draftSurface, key) !== sourceId) return null
    return `${targetId}${key.slice(sourceId.length)}`
  }
  if (draftSurface === 'ask') {
    const parts = parseDraftKey('ask', key)
    return parts && parts[1] === `new-${sourceId}` ? `${parts[0]}:new-${targetId}` : null
  }
  return null
}

async function moveDrafts({ tx, userId, sourceId, targetId }: MergeContext) {
  const rows = await tx.studyDraft.findMany({
    where: { userId, OR: [{ topicId: sourceId }, { scopeKey: { contains: sourceId } }] },
    select: { id: true, surface: true, scopeKey: true, topicId: true },
  })
  for (const row of rows) {
    const key = rewriteDraftKey(row.surface, row.scopeKey, sourceId, targetId) ?? row.scopeKey
    const taken = key === row.scopeKey ? null : await tx.studyDraft.findFirst({ where: { userId, surface: row.surface, scopeKey: key }, select: { id: true } })
    if (taken) {
      // Both topics had an unsent draft at the same place: the target's stays.
      await tx.studyDraft.delete({ where: { id: row.id } })
      continue
    }
    await tx.studyDraft.update({ where: { id: row.id }, data: { scopeKey: key, topicId: row.topicId === sourceId ? targetId : row.topicId } })
  }
}

async function moveTutorStates({ tx, userId, sourceId, targetId }: MergeContext) {
  const rows = await tx.tutorState.findMany({ where: { userId, scope: 'reader', scopeKey: { startsWith: `${sourceId}:` } }, select: { id: true, scopeKey: true } })
  for (const row of rows) {
    const key = readerKey(targetId, row.scopeKey.slice(sourceId.length + 1))
    const taken = await tx.tutorState.findUnique({ where: { userId_scope_scopeKey: { userId, scope: 'reader', scopeKey: key } }, select: { id: true } })
    if (taken) await tx.tutorState.delete({ where: { id: row.id } })
    else await tx.tutorState.update({ where: { id: row.id }, data: { scopeKey: key } })
  }
}

/** Practice tutor states are keyed by the topic's practice content; a content row that does not survive the merge takes its states. */
async function dropPracticeStatesOfContent(tx: Tx, userId: string, topicId: string) {
  const contents = await tx.topicContent.findMany({ where: { topicId, contentType: 'interactive_examples' }, select: { id: true } })
  for (const content of contents) {
    await tx.tutorState.deleteMany({ where: { userId, scope: 'practice', scopeKey: { startsWith: `${content.id}:` } } })
  }
}

export const TOPIC_REFERENCES: TopicReference[] = [
  // ---- Course structure and generated content (the route's own rules) ----
  { model: 'TopicSource', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: move(({ tx, sourceId, targetId }) => tx.topicSource.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'The sections the source was taught from.' },
  { model: 'TopicChunkMapping', column: 'topicId', merge: 'route', onDelete: 'cascade', note: 'A chunk both topics map to keeps the higher relevance score.' },
  { model: 'TopicContent', column: 'topicId', merge: 'route', onDelete: 'cascade', note: 'Content of a type the target lacks moves; the target keeps its own otherwise (unique topic + type).' },
  { model: 'TopicQuiz', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: move(({ tx, sourceId, targetId }) => tx.topicQuiz.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'All quiz sets move.' },
  { model: 'TopicProgress', column: 'topicId', merge: 'route', onDelete: 'cascade', note: 'One row per user and topic: checkmarks OR-ed, best score kept.' },
  { model: 'ReviewSchedule', column: 'topicId', merge: 'route', onDelete: 'cascade', note: 'One row per user and topic: the target\'s wins; recomputed from the moved concepts afterwards.' },
  { model: 'VoiceDrillSet', column: 'topicId', merge: 'drop', onDelete: 'cascade', note: 'A cache of generated drill questions keyed by topic and inputs hash; the target builds its own.' },

  // ---- Learning history ----
  { model: 'QuizAttempt', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: move(({ tx, sourceId, targetId }) => tx.quizAttempt.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: '' },
  { model: 'QuizSubmission', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: move(({ tx, sourceId, targetId }) => tx.quizSubmission.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: '' },
  { model: 'LearningSignal', column: 'topicId', merge: 'move', onDelete: 'keep', apply: move(({ tx, sourceId, targetId }) => tx.learningSignal.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'Signals stay with the course when a topic is deleted (topic cleared).' },
  { model: 'VoiceDrillSession', column: 'topicId', merge: 'move', onDelete: 'keep', apply: move(({ tx, sourceId, targetId }) => tx.voiceDrillSession.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: '' },
  { model: 'VoiceDrillAttempt', column: 'topicId', merge: 'move', onDelete: 'keep', apply: move(({ tx, sourceId, targetId }) => tx.voiceDrillAttempt.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: '' },
  { model: 'RecallAttempt', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: move(({ tx, sourceId, targetId }) => tx.recallAttempt.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'No unique key on the topic.' },
  { model: 'PracticeProgress', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: move(({ tx, sourceId, targetId }) => tx.practiceProgress.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'Unique (user, content, problem) does not involve the topic. Progress on a practice set the target replaced stays as history and is not shown against the new set.' },

  // ---- Concepts: mastery and review dates live here ----
  { model: 'Concept', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: move(({ tx, sourceId, targetId }) => tx.concept.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'Concept ids are kept, so claims, edges, memory and evidence stay attached.' },
  { model: 'ConceptMemory', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: move(({ tx, sourceId, targetId }) => tx.conceptMemory.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'Unique (user, concept): concept ids are kept, so nothing collides.' },
  { model: 'EvidenceEvent', column: 'topicId', merge: 'move', onDelete: 'keep', apply: move(({ tx, sourceId, targetId }) => tx.evidenceEvent.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'On delete the events go with their concepts (concept foreign key) even though this column is only cleared.' },

  // ---- The student's writing ----
  { model: 'MarginNote', column: 'topicId', merge: 'move', onDelete: 'keep', apply: move(({ tx, sourceId, targetId }) => tx.marginNote.updateMany({ where: { topicId: sourceId }, data: { topicId: targetId } })), note: 'On delete the topic is cleared and the note stays (project and quote are kept): "Notes from removed topics".' },
  { model: 'StudyDraft', column: 'topicId', merge: 'move', onDelete: 'cascade', apply: moveDrafts, note: 'Unique (user, surface, scopeKey): keys that start with the topic id are rewritten; if the target has an unsent draft at the same key, the target\'s stays.' },

  // ---- Scope keys and arrays that hold a topic id ----
  { model: 'StudyDraft', column: 'scopeKey', merge: 'move', onDelete: 'cascade', note: 'Rewritten with the topicId column (quiz, recall, explainer_check, worked_example start with the topic id; an ask draft\'s "new-<topicId>").' },
  { model: 'TutorState', column: 'scopeKey', merge: 'move', onDelete: 'cleanup', apply: moveTutorStates, note: 'Reader states are keyed "<topicId>:<chunkId>" and are renamed; if the target has one for the chunk it stays. Practice states are keyed by content id and follow the content; those of a content row that does not survive are deleted. Ask and voice states do not name a topic. PR 3 gives the table a real topic key.' },
  { model: 'ItemSession', column: 'topicIds', merge: 'move', onDelete: 'cleanup', note: 'The source id in the array is replaced by the target id.' },
  { model: 'Topic', column: 'prerequisiteIds', merge: 'route', onDelete: 'cleanup', note: 'Other topics that listed the source now list the target (loops dropped); on delete the id is removed.' },
  { model: 'Topic', column: 'sourceMaterialIds', merge: 'route', onDelete: 'cascade', note: 'Material ids, not topic ids: joined into the target.' },
  { model: 'SampleExam', column: 'questions', merge: 'none', onDelete: 'keep', note: 'Stored exam questions carry the topic id they were drawn from; an id of a deleted or merged topic is looked up as unknown and the question stays. Past exams are history and are not rewritten.' },
  { model: 'Material', column: 'examTopicMap', merge: 'none', onDelete: 'keep', note: 'May name topics deleted since (documented in the schema); readers skip unknown ids.' },
  { model: 'ProcessingJob', column: 'inputData', merge: 'none', onDelete: 'keep', note: 'Job targets such as "content:<topicId>:<type>" end with the job; a job for a deleted topic fails as not found.' },
]

/** Runs the 'move' rules of the registry: after this, nothing student-made is left on the source topic. */
export async function moveTopicReferences(ctx: MergeContext): Promise<void> {
  // Practice states of content that will not survive (the target has its own): before the content rows are settled by the route.
  const [sourceContents, targetContents] = await Promise.all([
    ctx.tx.topicContent.findMany({ where: { topicId: ctx.sourceId }, select: { contentType: true } }),
    ctx.tx.topicContent.findMany({ where: { topicId: ctx.targetId }, select: { contentType: true } }),
  ])
  const targetTypes = new Set(targetContents.map((item) => item.contentType))
  if (sourceContents.some((item) => item.contentType === 'interactive_examples') && targetTypes.has('interactive_examples')) {
    await dropPracticeStatesOfContent(ctx.tx, ctx.userId, ctx.sourceId)
  }
  for (const reference of TOPIC_REFERENCES) {
    if (reference.merge === 'move' && reference.apply) await reference.apply(ctx)
  }
  // ItemSession.topicIds
  await ctx.tx.$executeRaw`UPDATE item_sessions SET topic_ids = ARRAY(SELECT DISTINCT CASE WHEN t = ${ctx.sourceId} THEN ${ctx.targetId} ELSE t END FROM unnest(topic_ids) AS t)
    WHERE user_id = ${ctx.userId} AND ${ctx.sourceId} = ANY(topic_ids)`
}

/** The delete rules the schema cannot express: tutor states keyed by the topic or its practice content, and the id in item sessions. */
export async function deleteTopicReferences(tx: Tx, userId: string, topicId: string): Promise<void> {
  await tx.tutorState.deleteMany({ where: { userId, scope: 'reader', scopeKey: { startsWith: `${topicId}:` } } })
  await dropPracticeStatesOfContent(tx, userId, topicId)
  await tx.$executeRaw`UPDATE item_sessions SET topic_ids = array_remove(topic_ids, ${topicId}) WHERE user_id = ${userId} AND ${topicId} = ANY(topic_ids)`
}
