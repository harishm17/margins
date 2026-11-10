/**
 * The mastery switch (spec §3.6): a topic with concepts gets its mastery from them, a topic without
 * keeps the legacy blend. Against a real, migrated Postgres (DATABASE_URL).
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./mastery')
let math: typeof import('./mastery-math')
let evidence: typeof import('./evidence')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./mastery')
  math = await import('./mastery-math')
  evidence = await import('./evidence')
  available = await prisma.$queryRaw`SELECT 1 FROM evidence_events LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

const dbTest = (name: string, run: () => Promise<void>) =>
  test(name, async (t) => {
    if (!available) return t.skip('no migrated test database')
    await run()
  })

async function world() {
  const user = await prisma.user.create({ data: { email: `ms-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const legacy = await prisma.topic.create({ data: { projectId: project.id, name: 'Legacy', orderIndex: 0, userConfirmed: true } })
  const withConcepts = await prisma.topic.create({ data: { projectId: project.id, name: 'Concepts', orderIndex: 1, userConfirmed: true } })
  const concept = await prisma.concept.create({
    data: { projectId: project.id, topicId: withConcepts.id, name: 'C', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  return { user, project, legacy, withConcepts, concept }
}

const addQuizAttempt = (userId: string, topicId: string, score: number) =>
  prisma.quizAttempt.create({ data: { userId, topicId, answers: {}, results: {}, score } })

dbTest('legacy topic keeps blend mastery', async () => {
  const w = await world()
  await addQuizAttempt(w.user.id, w.legacy.id, 80)
  // A topic whose concept extraction failed or never ran has no concepts. Retired ones do not count.
  await prisma.concept.create({
    data: { projectId: w.project.id, topicId: w.legacy.id, name: 'Gone', summary: 's', kind: 'concept', orderIndex: 0, status: 'removed' },
  })

  const expected = math.masteryFromHistory({ quiz: [{ score: 80, at: new Date() }], voice: [], exam: [], practice: [], now: Date.now() })
  const got = await mod.computeTopicMastery(w.user.id, w.project.id, w.legacy.id)
  assert.ok(got.mastery > 0)
  assert.ok(Math.abs(got.mastery - expected.mastery) < 1e-3)

  // The same call over both topics: the legacy topic is unchanged next to a concept topic.
  const both = await mod.computeProjectMastery(w.user.id, w.project.id, [w.legacy.id, w.withConcepts.id])
  assert.ok(Math.abs((both.get(w.legacy.id)?.mastery ?? -1) - got.mastery) < 1e-3)
  assert.ok(both.has(w.withConcepts.id))

  // Every surface that reads the schedule still gets a row: recording a signal and a schedule works.
  await mod.upsertReviewSchedule({ userId: w.user.id, projectId: w.project.id, topicId: w.legacy.id, mastery: got.mastery })
  const schedule = await prisma.reviewSchedule.findUniqueOrThrow({ where: { userId_topicId: { userId: w.user.id, topicId: w.legacy.id } } })
  assert.ok(Math.abs(schedule.mastery - got.mastery) < 1e-3)
})

dbTest('concept topic uses concept mastery', async () => {
  const w = await world()
  // Its history has been converted (the backfill marks the topic).
  await prisma.topic.update({ where: { id: w.withConcepts.id }, data: { evidenceBackfilledAt: new Date() } })
  // Legacy history that would give a high blend on the concept topic...
  await addQuizAttempt(w.user.id, w.withConcepts.id, 100)
  // ...and one level-0 answer on its concept (cap 0.5 with one answer).
  await evidence.recordEvidence(
    [
      {
        userId: w.user.id,
        projectId: w.project.id,
        topicId: w.withConcepts.id,
        itemKey: 'quiz:s:0',
        conceptIds: [w.concept.id],
        source: 'quiz',
        score: 1,
        assistance: 0,
        gradedBy: 'rule',
        sessionKey: 'quiz:a1',
      },
    ],
    { timeZone: 'UTC' }
  )
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: w.concept.id } } })
  const got = await mod.computeTopicMastery(w.user.id, w.project.id, w.withConcepts.id)
  assert.ok(Math.abs(got.mastery - memory.mastery) < 1e-2, `${got.mastery} vs ${memory.mastery}`)
  assert.ok(got.mastery <= 0.5 + 1e-9)

  // The schedule evidence wrote agrees with what the surfaces read.
  const schedule = await prisma.reviewSchedule.findUniqueOrThrow({ where: { userId_topicId: { userId: w.user.id, topicId: w.withConcepts.id } } })
  assert.ok(Math.abs(schedule.mastery - got.mastery) < 1e-2)
})

dbTest('a converted topic is read from its concepts at read time, and a legacy upsert does not overwrite its schedule', async () => {
  const standing = await import('./topic-standing')
  const w = await world()
  await prisma.topic.update({ where: { id: w.withConcepts.id }, data: { evidenceBackfilledAt: new Date() } })
  const at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  await evidence.recordEvidence(
    [
      {
        userId: w.user.id,
        projectId: w.project.id,
        topicId: w.withConcepts.id,
        itemKey: 'quiz:s:0',
        conceptIds: [w.concept.id],
        source: 'quiz',
        score: 1,
        assistance: 0,
        gradedBy: 'rule',
        sessionKey: 'quiz:a1',
        at,
      },
    ],
    { timeZone: 'UTC' }
  )
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: w.concept.id } } })
  const before = await prisma.reviewSchedule.findUniqueOrThrow({ where: { userId_topicId: { userId: w.user.id, topicId: w.withConcepts.id } } })

  // The legacy interval rule (a quiz, practice, a voice drill, an exam) leaves a converted topic's row alone.
  await mod.upsertReviewSchedule({ userId: w.user.id, projectId: w.project.id, topicId: w.withConcepts.id, mastery: 0.95, wasCorrect: true })
  const after = await prisma.reviewSchedule.findUniqueOrThrow({ where: { userId_topicId: { userId: w.user.id, topicId: w.withConcepts.id } } })
  assert.equal(after.dueAt.getTime(), before.dueAt.getTime())
  assert.equal(after.mastery, before.mastery)

  // A stale stored row cannot reach the screens: the figures come from the concepts' memory.
  await prisma.reviewSchedule.update({
    where: { userId_topicId: { userId: w.user.id, topicId: w.withConcepts.id } },
    data: { mastery: 0.99, dueAt: new Date('2031-01-01T00:00:00Z') },
  })
  const got = await standing.topicStanding(w.user.id, w.withConcepts.id)
  assert.equal(got.dueAt!.getTime(), memory.dueAt!.getTime())
  assert.ok(got.mastery! <= 0.5 + 1e-9)
  assert.ok(Math.abs(got.mastery! - (await mod.computeTopicMastery(w.user.id, w.project.id, w.withConcepts.id)).mastery) < 1e-6)

  // A topic with no concepts keeps its row, faded when late.
  await addQuizAttempt(w.user.id, w.legacy.id, 80)
  await mod.upsertReviewSchedule({ userId: w.user.id, projectId: w.project.id, topicId: w.legacy.id, mastery: 0.6 })
  const legacy = await standing.topicStanding(w.user.id, w.legacy.id)
  assert.equal(legacy.mastery, 0.6)
  assert.ok(legacy.dueAt)
})
