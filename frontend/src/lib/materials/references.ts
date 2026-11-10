/**
 * Every stored pointer to a material (an uploaded file) or to one of its chunks, with what happens to it when the file is
 * deleted, when the file is replaced, when the course is deleted and when the account is deleted (plan SW13, F0, F7).
 *
 * References are found by reading `prisma/schema.prisma`: columns, `Json` fields, `*Ids String[]` arrays and keys that
 * carry an id (`TutorState.scopeKey`, job `targetKey`s). `references.test.ts` fails when a column of those kinds is in
 * neither `REFERENCES` nor `NOT_REFERENCES`, when an entry has no rule, and when a foreign key's `onDelete` is not the
 * one its rule needs. Add the entry in the change that adds the column.
 *
 * The three rules:
 * - `remove`: the pointer, and what only exists because of it, goes (a claim taken from the file, a chunk, a mapping).
 * - `keep-and-mark`: the pointer stays because it is the student's writing or a record they were shown; the screens that
 *   show it say the file is gone (a note under "Notes from removed files", a source link that no longer opens).
 * - `re-anchor-by-text`: on Replace the pointer follows the new file by its text (exact quote first, then a close match on
 *   the same page); what cannot be found is kept and marked "source changed".
 *
 * Course delete and account delete remove everything the student owns, so their rule is always `remove`; what differs is
 * the mechanism (`how`), because a pointer with no foreign key is not cleared by the database.
 *
 * Replace today is "upload the new file, then delete the old one" (F2 replaces it in PR 3, keeping the material id and
 * the ids of chunks whose text is unchanged). Until then the delete rules are what a Replace does, so the student's notes
 * survive it by the same rule.
 */

import type { Prisma } from '@prisma/client'

export type Rule = 'keep-and-mark' | 're-anchor-by-text' | 'remove'
export const RULES: readonly Rule[] = ['keep-and-mark', 're-anchor-by-text', 'remove']

/** How the rule is carried out: by a foreign key, by code in this module (`explicit`), by leaving the value as it is (`left-in-place`; the readers cope), or not yet. */
export type How = 'fk-cascade' | 'fk-set-null' | 'explicit' | 'left-in-place' | 'not-yet'

export type Reference = {
  id: string
  /** `Model.field` in the Prisma schema; every one is checked against it. */
  columns: readonly string[]
  /** Where in the column the id sits, for the reader of this list. */
  shape: string
  holds: 'material' | 'chunk' | 'material and chunk' | 'claim of the file'
  onDelete: Rule
  onReplace: Rule
  /** Always `remove` (everything the student owns goes); `how` says which mechanism does it. */
  onCourseDelete: 'remove'
  onAccountDelete: 'remove'
  /** What carries out the file delete rule. */
  how: How
  /** Free text: what the rule means here, or why it is not carried out yet. */
  note: string
  /** When the rules above are not all carried out yet: the plan item that does it. The guard allows it only with a reason. */
  until?: { pr: string; reason: string }
}

export const REFERENCES: readonly Reference[] = [
  {
    id: 'chunks',
    columns: ['MaterialChunk.materialId'],
    shape: 'foreign key',
    holds: 'material',
    onDelete: 'remove',
    onReplace: 're-anchor-by-text',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'fk-cascade',
    note: 'The file’s text. On Replace, chunks whose text is unchanged keep their ids (F2), the rest are new.',
  },
  {
    id: 'topic-sources',
    columns: ['TopicSource.materialId'],
    shape: 'foreign key, with a range of chunk indexes',
    holds: 'material',
    onDelete: 'remove',
    onReplace: 're-anchor-by-text',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'fk-cascade',
    note: 'Which sections of the file a topic is taught from. A topic left with no source is taught from a search of the course files.',
  },
  {
    id: 'topic-chunk-mappings',
    columns: ['TopicChunkMapping.chunkId'],
    shape: 'foreign key',
    holds: 'chunk',
    onDelete: 'remove',
    onReplace: 're-anchor-by-text',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'fk-cascade',
    note: 'Which chunks are relevant to a topic.',
  },
  {
    id: 'topic-source-ids',
    columns: ['Topic.sourceMaterialIds'],
    shape: 'array of material ids',
    holds: 'material',
    onDelete: 'remove',
    onReplace: 'keep-and-mark',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'explicit',
    note: 'The id leaves every topic of the course (removeMaterialReferences); the topics read as taught from the files they still have. Replace keeps the id (F2).',
  },
  {
    id: 'concept-claims',
    columns: ['ConceptClaim.materialId', 'ConceptClaim.chunkId'],
    shape: 'foreign key (material), plain id (chunk, no foreign key: chunks are rewritten when a file is read again)',
    holds: 'material and chunk',
    onDelete: 'remove',
    onReplace: 're-anchor-by-text',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'fk-cascade',
    note: 'Derived from the file. An active idea left with no claim "needs re-reading" (needsRereadingWhere); recall, quick checks, pointers and focus passages skip it, and a re-quote job looks for it in the topic’s other files.',
  },
  {
    id: 'margin-notes',
    columns: ['MarginNote.materialId', 'MarginNote.chunkId'],
    shape: 'foreign key set null (material), plain id (chunk); the passage is copied to MarginNote.quote',
    holds: 'material and chunk',
    onDelete: 'keep-and-mark',
    onReplace: 're-anchor-by-text',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'fk-set-null',
    note: 'The student’s own writing. A note whose file is gone keeps its text and quote and is listed under "Notes from removed files" (DetachedNotes).',
  },
  {
    id: 'reader-check-drafts',
    columns: ['StudyDraft.scopeKey'],
    shape: 'surface reader_check: the key is a claim id',
    holds: 'claim of the file',
    onDelete: 'remove',
    onReplace: 're-anchor-by-text',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'explicit',
    note: 'A half-typed answer to a quick check built from a claim that is gone cannot be shown again, so it goes with the claim. Other draft surfaces are keyed by topic, set or session.',
  },
  {
    id: 'ask-citations',
    columns: ['ChatMessage.citations'],
    shape: 'sources[]: { chunk_id, material_id, filename, page }',
    holds: 'material and chunk',
    onDelete: 'keep-and-mark',
    onReplace: 'keep-and-mark',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'left-in-place',
    note: 'The answer and its quote stay as the student saw them; the link to the file stops opening (the file route answers 404). A "file removed" marker on the citation arrives with X3 (PR 3).',
  },
  {
    id: 'stored-item-sources',
    columns: [
      'TopicContent.contentData',
      'TopicContent.metadata',
      'TopicQuiz.questions',
      'QuizSubmission.questions',
      'OverallQuiz.questions',
      'SampleExam.questions',
      'ExamSubmission.aiGrading',
      'ItemSession.items',
      'VoiceDrillSet.questions',
      'VoiceDrillSession.questionSet',
    ],
    shape: 'sources[]: { material_id, filename, page_start, page_end } on each item; notes’ citations[]: { material_id, filename, pages }',
    holds: 'material',
    onDelete: 'keep-and-mark',
    onReplace: 'keep-and-mark',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'left-in-place',
    note: 'Generated content stays ("Existing topic content stays"); its "From file, p. N" line keeps the filename and the link stops opening. A "file removed" marker arrives with X3 (PR 3).',
  },
  {
    id: 'gap-explainer-source',
    columns: ['RecallAttempt.explainer'],
    shape: 'source: { material_id, filename, page }',
    holds: 'material',
    onDelete: 'keep-and-mark',
    onReplace: 'keep-and-mark',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'left-in-place',
    note: 'The written explanation stays; its page link stops opening.',
  },
  {
    id: 'reader-evidence',
    columns: ['EvidenceEvent.metadata'],
    shape: 'reader events: { chunkId }',
    holds: 'chunk',
    onDelete: 'keep-and-mark',
    onReplace: 'keep-and-mark',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'left-in-place',
    note: 'Evidence is the record of what the student did, so it stays; nothing reads the chunk id back to open a passage.',
  },
  {
    id: 'job-keys',
    columns: ['ProcessingJob.targetKey', 'ProcessingJob.inputData', 'ProcessingJob.resultData'],
    shape: 'targetKey chunk:<materialId> and profile:<materialId>; inputData { materialId }',
    holds: 'material',
    onDelete: 'keep-and-mark',
    onReplace: 'remove',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'left-in-place',
    note: 'Finished jobs are history (cost, errors) and stay. A job still running for a deleted file ends as MATERIAL_NOT_FOUND in the AI service. Replace (F2) starts new jobs for the same id.',
  },
  {
    id: 'tutor-state-scope-keys',
    columns: ['TutorState.scopeKey'],
    shape: 'scope reader: <topicId>:<chunkId>; scope ask: a thread id; scope practice: a content id',
    holds: 'chunk',
    onDelete: 'keep-and-mark',
    onReplace: 're-anchor-by-text',
    onCourseDelete: 'remove',
    onAccountDelete: 'remove',
    how: 'not-yet',
    note: 'TutorState has only a user key, so a deleted file’s or course’s tutor states stay until the account goes.',
    until: { pr: 'PR 3', reason: 'finding 101 adds TutorState.projectId with ON DELETE CASCADE and a real topic/chunk key; allow-listed until then' },
  },
]

/**
 * Columns the guard reads as possible references (a `Json`, an `*Ids String[]`, a column named for a material or chunk,
 * a key column) that hold no material or chunk id, each with the reason. A new column of those kinds needs a line here
 * or in `REFERENCES`.
 */
export const NOT_REFERENCES: Readonly<Record<string, string>> = {
  'Material.metadata': 'what the validator saw in the file (kind, page count); ids of nothing',
  'Material.styleProfile': 'how a past exam is written; paraphrased stems',
  'Material.examTopicMap': 'topic ids, no file or chunk ids; goes with the file itself',
  'Topic.prerequisiteIds': 'topic ids of the same course',
  'QuizAttempt.answers': 'the student’s answers',
  'QuizAttempt.results': 'grading per question; no file ids (the sources are on the quiz)',
  'QuizAttempt.evidencePending': 'concept ids',
  'QuizSubmission.answers': 'the student’s answers',
  'QuizSubmission.aiGrading': 'grading per question; no file ids',
  'QuizSubmission.ruleResults': 'grading per question; no file ids',
  'VoiceDrillSession.metrics': 'timings and counts',
  'VoiceDrillSession.history': 'the conversation',
  'VoiceDrillSession.coachState': 'claim and concept ids of the idea being taught (claims are derived and go with the file)',
  'VoiceTurnTiming.ttftMs': 'milliseconds',
  'VoiceTurnTiming.client': 'what the browser measured',
  'VoiceDrillAttempt.expectedAnswer': 'answer text',
  'VoiceDrillAttempt.feedback': 'feedback text',
  'VoiceDrillAttempt.timing': 'milliseconds',
  'LearningSignal.metadata': 'signal details; no file or chunk ids',
  'PracticeProgress.maxRungs': 'hint rungs',
  'PracticeProgress.missRungs': 'hint rungs',
  'OverallQuizAttempt.answers': 'the student’s answers',
  'OverallQuizAttempt.score': 'a score',
  'ExamSubmission.answers': 'the student’s answers',
  'ExamSubmission.aiFeedback': 'feedback text',
  'ChatMessage.tutor': 'Ask’s route and check card; the card names a concept, not a file',
  'ConceptMemory.card': 'the review schedule card',
  'ConceptMemory.derived': 'derived numbers',
  'RecallAttempt.result': 'verdicts per claim with the claim’s text and quote copied in; claim ids go with the file',
  'MarginNote.reply': 'the tutor’s reply, verdict and parent note id; no file ids',
  'StudyDraft.payload': 'what the student typed',
  'TutorState.conceptIds': 'concept ids',
  'TutorState.understandConcepts': 'concept ids',
  'ItemSession.topicIds': 'topic ids',
  'ItemSession.answers': 'the student’s answers',
  'ItemSession.results': 'grading per item; no file ids',
  'SampleExam.topicsCovered': 'topic names',
}

type Db = Pick<Prisma.TransactionClient, 'topic' | 'studyDraft' | 'conceptClaim'> & Pick<Prisma.TransactionClient, '$executeRaw'>

/**
 * The explicit part of the file delete rules (those the foreign keys do not do), in the transaction that deletes the
 * material row. Call it before the delete: it reads the file’s claims, which the delete cascades away.
 */
export async function removeMaterialReferences(tx: Db, material: { id: string; projectId: string }): Promise<void> {
  // Topic.sourceMaterialIds: the id leaves the array (a plain array, no foreign key).
  await tx.$executeRaw`
    UPDATE topics SET source_material_ids = array_remove(source_material_ids, ${material.id})
    WHERE project_id = ${material.projectId} AND ${material.id} = ANY(source_material_ids)`
  // Drafts of quick checks built from this file’s claims.
  const claims = await tx.conceptClaim.findMany({ where: { materialId: material.id }, select: { id: true } })
  if (claims.length > 0) {
    await tx.studyDraft.deleteMany({ where: { surface: 'reader_check', scopeKey: { in: claims.map((claim) => claim.id) } } })
  }
}

type ProjectTx = Pick<Prisma.TransactionClient, 'material' | 'project' | 'pendingFileDeletion'>

/**
 * Deletes one file: the explicit steps, the row (the database applies the foreign-key rules: chunks, mappings, sources and
 * claims go, notes lose their link), and the stored file queued for deletion in the same transaction. Returns the queued
 * storage paths, to try right after the commit.
 */
export async function deleteMaterial(
  tx: Db & ProjectTx,
  material: { id: string; projectId: string; gcsPath: string }
): Promise<string[]> {
  await removeMaterialReferences(tx, material)
  await tx.material.delete({ where: { id: material.id } })
  const { queueFileDeletions } = await import('@/lib/storage/pending-deletions')
  return queueFileDeletions(tx, [material.gcsPath], 'material_deleted')
}

/**
 * Deletes a course. Every file-level pointer goes with its rows by the foreign keys (rule `remove` for a course), so the
 * explicit work is the stored files: each file’s path and the course’s folder, queued in the same transaction.
 */
export async function deleteCourse(tx: ProjectTx, course: { id: string; userId: string }): Promise<string[]> {
  const paths = await materialStoragePaths(tx, { projectId: course.id })
  await tx.project.delete({ where: { id: course.id } })
  const [{ queueFileDeletions }, { storedFolderPath }] = await Promise.all([import('@/lib/storage/pending-deletions'), import('@/lib/storage/files')])
  return queueFileDeletions(tx, [...paths, storedFolderPath(`${course.userId}/${course.id}/`)], 'project_deleted')
}

/** The storage path of every file of a course or of an account (before its rows are gone). */
export async function materialStoragePaths(
  db: Pick<Prisma.TransactionClient, 'material'>,
  scope: { projectId: string } | { userId: string }
): Promise<string[]> {
  const rows = await db.material.findMany({
    where: 'projectId' in scope ? { projectId: scope.projectId } : { project: { userId: scope.userId } },
    select: { gcsPath: true },
  })
  return rows.map((row) => row.gcsPath).filter(Boolean)
}
