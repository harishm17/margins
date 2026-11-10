/**
 * Merging and deleting topics keep the student's work (finding 78). Against a migrated Postgres (DATABASE_URL); skipped without one.
 *
 * Topic A has a margin note, a recall attempt, practice progress, an unsent draft, a reader tutor state and an idea with memory
 * and evidence; it is merged into B. Topic C has a note and a tutor state; it is deleted.
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

type Prisma = typeof import('@/lib/db/prisma').prisma

let prisma: Prisma
let available = false
let userId = ''
const ids = {} as Record<'project' | 'a' | 'b' | 'c' | 'concept' | 'chunk' | 'content', string>
const due = new Date('2027-01-15T00:00:00Z')

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  available = await prisma.$queryRaw`SELECT 1 FROM evidence_events LIMIT 1`.then(() => true, () => false)
  if (!available) return
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const user = await prisma.user.create({ data: { email: `merge-${stamp}@example.com` } })
  userId = user.id
  const project = await prisma.project.create({ data: { userId, name: 'Merge course' } })
  const material = await prisma.material.create({ data: { projectId: project.id, category: 'lecture_notes', filename: 'm.pdf', gcsPath: `x/m-${stamp}.pdf`, sizeBytes: BigInt(10) } })
  const chunk = await prisma.materialChunk.create({ data: { materialId: material.id, chunkText: 'The mean is the sum over the count.', chunkIndex: 0 } })
  const topic = (name: string, orderIndex: number) =>
    prisma.topic.create({ data: { projectId: project.id, name, orderIndex, userConfirmed: true, evidenceBackfilledAt: new Date() } })
  const [a, b, c] = [await topic('A', 0), await topic('B', 1), await topic('C', 2)]
  const concept = await prisma.concept.create({ data: { projectId: project.id, topicId: a.id, name: 'Mean', summary: 's', kind: 'concept', orderIndex: 0 } })
  const content = await prisma.topicContent.create({ data: { topicId: a.id, contentType: 'interactive_examples', contentData: {} } })
  Object.assign(ids, { project: project.id, a: a.id, b: b.id, c: c.id, concept: concept.id, chunk: chunk.id, content: content.id })

  const note = (topicId: string, text: string) =>
    prisma.marginNote.create({ data: { userId, projectId: project.id, topicId, materialId: material.id, chunkId: chunk.id, quote: chunk.chunkText, kind: 'note', text } })
  await note(a.id, 'note on A')
  await note(c.id, 'note on C')
  await prisma.recallAttempt.create({ data: { userId, topicId: a.id, kind: 'recall', promptText: 'p', answerText: 'x', mode: 'text', result: {} } })
  await prisma.practiceProgress.create({ data: { userId, topicId: a.id, contentId: content.id, problemIndex: 0, problemTitle: 'T', stepsTotal: 2, stepsSolved: 1 } })
  await prisma.studyDraft.create({
    data: { userId, projectId: project.id, topicId: a.id, surface: 'recall', scopeKey: `${a.id}:card`, payload: { text: 'unsent', voice: false }, expiresAt: new Date(Date.now() + 86_400_000) },
  })
  await prisma.tutorState.create({ data: { userId, scope: 'reader', scopeKey: `${a.id}:${chunk.id}` } })
  await prisma.tutorState.create({ data: { userId, scope: 'reader', scopeKey: `${c.id}:${chunk.id}` } })
  await prisma.conceptMemory.create({ data: { userId, projectId: project.id, topicId: a.id, conceptId: concept.id, dueAt: due, lastReviewAt: new Date('2027-01-08T00:00:00Z'), stability: 7 } })
  await prisma.evidenceEvent.create({
    data: { userId, projectId: project.id, topicId: a.id, conceptId: concept.id, itemKey: 'k', source: 'quiz', score: 1, assistance: 0, weight: 1, role: 'primary', gradedBy: 'rule', sessionKey: 's' },
  })
  const { setTestSession } = await import('@/lib/auth/get-session')
  setTestSession({ user: { id: userId, email: user.email, name: null } })
})

after(async () => {
  if (!prisma) return
  if (available && userId) await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.$disconnect()
})

const dbTest = (name: string, run: () => Promise<void>) =>
  test(name, async (t) => {
    if (!available) return t.skip('no migrated test database')
    await run()
  })

dbTest('merging a topic keeps notes, recall, practice, drafts and the idea with its mastery and review date (78)', async () => {
  const { POST } = await import('@/app/api/projects/[projectId]/topics/merge/route')
  const response = await POST(
    new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ sourceTopicId: ids.a, targetTopicId: ids.b }), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ projectId: ids.project }) }
  )
  assert.equal(response.status, 200)
  assert.equal(await prisma.topic.count({ where: { id: ids.a } }), 0)

  assert.deepEqual((await prisma.marginNote.findMany({ where: { userId, text: 'note on A' } })).map((n) => n.topicId), [ids.b])
  assert.equal(await prisma.recallAttempt.count({ where: { topicId: ids.b } }), 1)
  assert.equal(await prisma.practiceProgress.count({ where: { topicId: ids.b } }), 1)
  const draft = await prisma.studyDraft.findFirstOrThrow({ where: { userId } })
  assert.equal(draft.topicId, ids.b)
  assert.equal(draft.scopeKey, `${ids.b}:card`)
  assert.equal(await prisma.tutorState.count({ where: { userId, scopeKey: `${ids.b}:${ids.chunk}` } }), 1)

  // The idea keeps its id, so its memory (the review date) and evidence are still there, under the target.
  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: ids.concept } })
  assert.equal(concept.topicId, ids.b)
  const memory = await prisma.conceptMemory.findFirstOrThrow({ where: { userId, conceptId: ids.concept } })
  assert.equal(memory.topicId, ids.b)
  assert.equal(memory.dueAt?.toISOString(), due.toISOString())
  assert.equal(await prisma.evidenceEvent.count({ where: { topicId: ids.b } }), 1)
  // The target's schedule is worked out again from the moved idea.
  const schedule = await prisma.reviewSchedule.findFirstOrThrow({ where: { userId, topicId: ids.b } })
  assert.equal(schedule.dueAt.toISOString(), due.toISOString())
})

dbTest('merging a topic whose history was not converted yet into a converted one leaves the target to be converted again', async () => {
  // Review of PR 1.6: the moved quizzes and practice were never replayed, because conversion only runs for an unconverted topic.
  const { POST } = await import('@/app/api/projects/[projectId]/topics/merge/route')
  const source = await prisma.topic.create({ data: { projectId: ids.project, name: 'D', orderIndex: 9, userConfirmed: true } })
  const target = await prisma.topic.create({ data: { projectId: ids.project, name: 'E', orderIndex: 10, userConfirmed: true, evidenceBackfilledAt: new Date() } })
  await prisma.concept.create({ data: { projectId: ids.project, topicId: source.id, name: 'Median', summary: 's', kind: 'concept', orderIndex: 0 } })
  const response = await POST(
    new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ sourceTopicId: source.id, targetTopicId: target.id }), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ projectId: ids.project }) }
  )
  assert.equal(response.status, 200)
  assert.equal((await prisma.topic.findUniqueOrThrow({ where: { id: target.id } })).evidenceBackfilledAt, null)
})

dbTest('deleting a topic keeps its notes under no topic and clears its tutor states (78)', async () => {
  const { DELETE } = await import('@/app/api/topics/[topicId]/route')
  const response = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), { params: Promise.resolve({ topicId: ids.c }) })
  assert.equal(response.status, 200)
  const note = await prisma.marginNote.findFirstOrThrow({ where: { userId, text: 'note on C' } })
  assert.equal(note.topicId, null)
  assert.equal(note.projectId, ids.project)
  assert.equal(note.quote, 'The mean is the sum over the count.')
  assert.equal(await prisma.tutorState.count({ where: { userId, scopeKey: { startsWith: `${ids.c}:` } } }), 0)

  // It is listed for the course, and only its owner can delete it.
  const { getRemovedTopicNotes } = await import('@/server/queries/course')
  assert.deepEqual((await getRemovedTopicNotes(userId, ids.project)).map((n) => n.text), ['note on C'])
  const { DELETE: removeNote } = await import('@/app/api/projects/[projectId]/removed-topic-notes/route')
  const call = (id: string) => removeNote(new NextRequest(`http://localhost/x?id=${id}`, { method: 'DELETE' }), { params: Promise.resolve({ projectId: ids.project }) })
  assert.equal((await call(note.id)).status, 200)
  assert.equal(await prisma.marginNote.count({ where: { id: note.id } }), 0)
  assert.equal((await call(note.id)).status, 404)
})
