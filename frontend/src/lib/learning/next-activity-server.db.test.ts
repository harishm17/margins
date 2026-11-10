/**
 * The state behind the next-activity cascade (spec §8.1), against a real, migrated Postgres (DATABASE_URL).
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

const UP = { ai: 'up' as const, now: new Date(), timeZone: 'UTC' }

let prisma: typeof import('@/lib/db/prisma').prisma
let server: typeof import('./next-activity-server')
let activity: typeof import('./next-activity')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  server = await import('./next-activity-server')
  activity = await import('./next-activity')
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
  const user = await prisma.user.create({ data: { email: `na-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  return { user, project, topic }
}

dbTest('a warm-up and "I\'ve read it" leave recall to do: evidence from the warm-up is not a recalled topic', async () => {
  const w = await world()
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const a = await prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name: 'A', summary: 's', kind: 'concept', orderIndex: 0 } })
  const now = new Date()
  await prisma.evidenceEvent.create({
    data: { userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, conceptId: a.id, itemKey: 'quiz:w:0', source: 'warmup', score: 0, assistance: 0, weight: 1, role: 'primary', gradedBy: 'rule', sessionKey: 'warmup:s' },
  })
  // The reader's "I've read it" sets readAt and marks the notes read; the warm-up's evidence is the only evidence.
  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, warmupAt: now, readAt: now, notesCompleted: true } })
  const state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(state.recallAt, null)
  assert.equal(activity.nextActivity(state, UP).kind, 'recall')

  // Notes marked read with no readAt (a mark-read before it was stamped), and only warm-up and reader evidence:
  // still not a recalled topic.
  const marked = await world()
  await prisma.topic.update({ where: { id: marked.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const m = await prisma.concept.create({ data: { projectId: marked.project.id, topicId: marked.topic.id, name: 'M', summary: 's', kind: 'concept', orderIndex: 0 } })
  for (const [source, assistance] of [['warmup', 0], ['reader', 2], ['reader', 3]] as const) {
    await prisma.evidenceEvent.create({
      data: { userId: marked.user.id, projectId: marked.project.id, topicId: marked.topic.id, conceptId: m.id, itemKey: `k:${source}:${assistance}`, source, score: 0, assistance, weight: 1, role: 'primary', gradedBy: 'rule', sessionKey: `s:${source}:${assistance}` },
    })
  }
  await prisma.topicProgress.create({ data: { userId: marked.user.id, topicId: marked.topic.id, notesCompleted: true } })
  const markedState = await server.loadTopicLearningState({ userId: marked.user.id, topicId: marked.topic.id })
  assert.equal(markedState.hasAnyEvidence, false)
  assert.equal(markedState.recallAt, null)
  assert.equal(activity.nextActivity(markedState, UP).kind, 'recall')

  // A topic read before v3 (no readAt) with history still counts as recalled.
  const old = await world()
  await prisma.topicProgress.create({ data: { userId: old.user.id, topicId: old.topic.id, notesCompleted: true, quizCompleted: true } })
  assert.notEqual((await server.loadTopicLearningState({ userId: old.user.id, topicId: old.topic.id })).recallAt, null)
})

dbTest('a misconception on a concept wins, and recall gaps and teach-back times are read', async () => {
  const w = await world()
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const a = await prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name: 'A', summary: 's', kind: 'concept', orderIndex: 0 } })
  const now = new Date()
  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, readAt: now, recallAt: now } })
  await prisma.recallAttempt.create({
    data: {
      userId: w.user.id,
      topicId: w.topic.id,
      kind: 'recall',
      promptText: 'p',
      answerText: 'x',
      mode: 'text',
      result: { claims: [{ concept_id: a.id, verdict: 'missing' }] },
    },
  })
  await prisma.recallAttempt.create({
    data: { userId: w.user.id, topicId: w.topic.id, kind: 'teach_back', promptText: 'p', answerText: 'x', mode: 'text', result: {} },
  })
  let state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.deepEqual(state.recallGaps, [a.id])
  assert.ok(state.lastTeachBackAt)
  assert.equal(activity.nextActivity(state, UP).kind, 'explainer')

  await prisma.conceptMemory.create({
    data: { userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, conceptId: a.id, misconception: 'wrong idea', misconceptionAt: now },
  })
  state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(activity.nextActivity(state, UP).kind, 'fix_misconception')
})

dbTest('a failing concept drills its weakest prerequisite, found across topics', async () => {
  const w = await world()
  const other = await prisma.topic.create({ data: { projectId: w.project.id, name: 'Other', orderIndex: 1, userConfirmed: true } })
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const mk = (topicId: string, name: string, orderIndex: number) =>
    prisma.concept.create({ data: { projectId: w.project.id, topicId, name, summary: 's', kind: 'concept', orderIndex } })
  const target = await mk(w.topic.id, 'Target', 0)
  const strong = await mk(w.topic.id, 'Strong', 1)
  const weak = await mk(other.id, 'Weak', 0)
  for (const source of [strong, weak]) {
    await prisma.conceptEdge.create({ data: { projectId: w.project.id, sourceId: source.id, targetId: target.id, type: 'prerequisite', weight: 1, confidence: 0.9 } })
  }
  const now = new Date()
  const memory = (conceptId: string, topicId: string, data: object) =>
    prisma.conceptMemory.create({ data: { userId: w.user.id, projectId: w.project.id, topicId, conceptId, ...data } })
  await memory(target.id, w.topic.id, { consecutiveFails: 2, nUnassisted: 1, lastEvidenceAt: now })
  // The other topic's prerequisite has no memory (mastery 0); Strong has a card and three good scores.
  const card = { due: now.toISOString(), stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 5, reps: 1, lapses: 0, state: 2, last_review: now.toISOString() }
  await memory(strong.id, w.topic.id, {
    card,
    dueAt: now,
    stability: 5,
    lastReviewAt: now,
    nUnassisted: 3,
    lastEvidenceAt: now,
    derived: { delayedNewSuccess: true, level0Scores: [1, 1, 1].map((score) => ({ score, at: now.toISOString() })) },
  })

  const state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  const found = state.concepts.find((c) => c.id === target.id)
  assert.equal(found?.weakestPrerequisiteId, weak.id)
  const next = activity.nextActivity({ ...state, readAt: now, recallAt: now, warmupAt: now, concepts: state.concepts.map((c) => ({ ...c, retrievability: 1 })) }, UP)
  assert.equal(next.kind, 'prerequisite_drill')
  assert.deepEqual(next.conceptIds, [weak.id, target.id])
})

dbTest('the v3.1 state: instruction, tested out, quick pass, ready explainers, a hard set on hand, the next review and first claims', async () => {
  const w = await world()
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const mk = (name: string, orderIndex: number) =>
    prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name, summary: 's', kind: 'concept', orderIndex } })
  const a = await mk('A', 0)
  const b = await mk('B', 1)
  const material = await prisma.material.create({ data: { projectId: w.project.id, category: 'lecture_notes', filename: 'notes.pdf', gcsPath: 'x', sizeBytes: 1 } })
  await prisma.conceptClaim.create({ data: { conceptId: a.id, text: 'second', quote: 'q', materialId: material.id, chunkId: 'chunk-2', pageStart: 9, pageEnd: 9, orderIndex: 1 } })
  await prisma.conceptClaim.create({ data: { conceptId: a.id, text: 'first', quote: 'q', materialId: material.id, chunkId: 'chunk-1', pageStart: 3, pageEnd: 4, orderIndex: 0 } })
  const now = new Date()
  const evidence = await import('./evidence')
  const answer = (conceptId: string, score: number) => ({
    userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, itemKey: `quiz:s:${conceptId}:${score}`, conceptIds: [conceptId], source: 'quiz' as const,
    score, assistance: 0 as const, gradedBy: 'rule' as const, sessionKey: `s-${conceptId}-${score}`,
  })
  // A failed today; B was Good today.
  await evidence.recordEvidence([answer(a.id, 0), answer(b.id, 1)], { timeZone: 'UTC' })

  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, readAt: now, recallAt: now, testedOutAt: now, triage: 'quick', triageAt: now } })
  await prisma.topicQuiz.create({ data: { topicId: w.topic.id, kind: 'standard', questions: [{ question_text: 'q', difficulty: 'hard' }] } })
  await prisma.recallAttempt.create({
    data: {
      userId: w.user.id, topicId: w.topic.id, kind: 'recall', promptText: 'p', answerText: 'x', mode: 'text',
      result: { claims: [{ concept_id: a.id, verdict: 'missing' }] },
      explainer: { status: 'ready', gaps: [{ claim_id: 'cl', concept_id: a.id, concept_name: 'A', explanation: 'e', check: { question: 'q', answer: 'a' }, source: {} }] },
    },
  })

  const state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id, now: new Date(), timeZone: 'UTC' })
  const sa = state.concepts.find((c) => c.id === a.id)!
  const sb = state.concepts.find((c) => c.id === b.id)!
  assert.equal(sa.needsInstruction, true)
  assert.ok(sa.lastFailAt)
  assert.equal(sa.hasCard, true)
  assert.deepEqual(sa.firstClaim, { page: 3, chunkId: 'chunk-1' })
  assert.equal(sb.needsInstruction, false)
  assert.equal(sb.firstClaim, null)
  assert.equal(sb.latestGroupGoodToday, true)
  assert.equal(sa.latestGroupGoodToday, false)
  assert.ok(state.testedOutAt)
  assert.equal(state.triage, 'quick')
  assert.deepEqual(state.gapExplainerReadyFor, [a.id])
  assert.equal(state.hardSetOnHand, true)
  const dues = (await prisma.conceptMemory.findMany({ where: { userId: w.user.id } })).map((m) => m.dueAt!.getTime())
  assert.equal(state.nextReviewAt!.getTime(), Math.min(...dues))
  // The failed concept leads to its ready explainer, not the reader.
  const next = activity.nextActivity(state, UP)
  assert.equal(next.kind, 'instruct')
  assert.equal(next.target?.via, 'explainer')
})
