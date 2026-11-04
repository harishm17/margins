/**
 * The state behind the next-activity cascade (spec §8.1), against a real, migrated Postgres (DATABASE_URL).
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { isHardSet, latestRecallGaps, recallGapConcepts } from './next-activity-server'

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

test('recallGapConcepts reads missing and incorrect claims, and nothing from junk', () => {
  const result = {
    claims: [
      { concept_id: 'a', verdict: 'covered' },
      { concept_id: 'b', verdict: 'missing' },
      { conceptId: 'c', verdict: 'incorrect' },
      { concept_id: 'b', verdict: 'incorrect' },
      { concept_id: 'd', verdict: 'partial' },
    ],
  }
  assert.deepEqual(recallGapConcepts(result), ['b', 'c'])
  assert.deepEqual(recallGapConcepts(null), [])
  assert.deepEqual(recallGapConcepts({ claims: 'x' }), [])
})

test('latestRecallGaps judges each concept by the newest attempt that covered it', () => {
  const claims = (...list: [string, string][]) => ({ claims: list.map(([concept_id, verdict]) => ({ concept_id, verdict })) })
  // Newest first: the second card left B open; the first card left A open until it was answered again.
  assert.deepEqual(latestRecallGaps([claims(['b', 'missing']), claims(['a', 'covered']), claims(['a', 'missing'], ['c', 'incorrect'])]), ['b', 'c'])
  assert.deepEqual(latestRecallGaps([claims(['a', 'covered'], ['a', 'missing'])]), ['a'])
  assert.deepEqual(latestRecallGaps([null, { claims: 'x' }, claims(['a', 'missing'])]), ['a'])
  assert.deepEqual(latestRecallGaps([]), [])
})

test('isHardSet needs every question hard', () => {
  assert.equal(isHardSet([{ difficulty: 'hard' }, { difficulty: 'hard' }]), true)
  assert.equal(isHardSet([{ difficulty: 'hard' }, { difficulty: 'medium' }]), false)
  assert.equal(isHardSet([]), false)
})

dbTest('legacy topic without concepts gets the old path', async () => {
  const w = await world()
  const state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.deepEqual(state.concepts, [])
  // Nothing has been made for the topic yet: it is sent to the topic, which names the first step once it is prepared.
  assert.equal(state.prepared, false)
  assert.equal(activity.nextActivity(state, UP).kind, 'start')

  // A topic from before concepts has its written notes: that is the reading.
  await prisma.topicContent.create({ data: { topicId: w.topic.id, contentType: 'section_notes', contentData: { text: 'Some notes.' } } })
  const prepared = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(prepared.prepared, true)
  assert.equal(activity.nextActivity(prepared, UP).kind, 'read')

  // Read, practice not done yet: practice comes before the first quiz (the order the path shows).
  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, notesCompleted: true } })
  const read = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(read.practiceDone, false)
  assert.equal(activity.nextActivity(read, UP).kind, 'practice')
  assert.equal(activity.nextActivity({ ...read, practiceDone: true }, UP).kind, 'quiz')

  await prisma.quizAttempt.create({ data: { userId: w.user.id, topicId: w.topic.id, answers: {}, results: {}, score: 70 } })
  const quizzed = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(activity.nextActivity(quizzed, UP).kind, 'practice')
})

dbTest('concepts before the evidence backfill keep the old path', async () => {
  const w = await world()
  await prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name: 'C', summary: 's', kind: 'concept', orderIndex: 0 } })
  const state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.deepEqual(state.concepts, [])
})

dbTest('a new topic with concepts and a warm-up bank starts at the warm-up, then read once read', async () => {
  const w = await world()
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const a = await prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name: 'A', summary: 's', kind: 'concept', orderIndex: 0 } })
  const b = await prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name: 'B', summary: 's', kind: 'concept', orderIndex: 1 } })
  await prisma.conceptEdge.create({ data: { projectId: w.project.id, sourceId: a.id, targetId: b.id, type: 'prerequisite', weight: 1, confidence: 0.9 } })
  await prisma.topicQuiz.create({ data: { topicId: w.topic.id, kind: 'warmup', questions: [] } })

  const state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.deepEqual(state.concepts.map((c) => c.id), [a.id, b.id])
  assert.deepEqual(state.concepts[1].prerequisiteIds, [a.id])
  assert.equal(state.warmupReady, true)
  assert.equal(activity.nextActivity(state, UP).kind, 'warmup')

  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, readAt: new Date() } })
  const read = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(activity.nextActivity(read, UP).kind, 'recall')
})

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

dbTest('only a recorded explainer view counts as a visit, not the gate opening', async () => {
  const w = await world()
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const a = await prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name: 'A', summary: 's', kind: 'concept', orderIndex: 0 } })
  const recalled = new Date('2026-10-01T00:00:00Z')
  await prisma.topicProgress.create({
    data: { userId: w.user.id, topicId: w.topic.id, readAt: recalled, recallAt: recalled, explainerUnlockedAt: new Date('2026-10-02T00:00:00Z'), explainerUnlockReason: 'thin_source' },
  })
  const attempt = await prisma.recallAttempt.create({
    data: { userId: w.user.id, topicId: w.topic.id, kind: 'recall', promptText: 'p', answerText: 'x', mode: 'text', createdAt: recalled, result: { claims: [{ concept_id: a.id, verdict: 'missing' }] } },
  })
  let state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(state.explainerVisitedAt, null)
  assert.equal(activity.nextActivity(state, UP).kind, 'explainer')

  await prisma.recallAttempt.update({ where: { id: attempt.id }, data: { explainer: { viewedAt: '2026-10-03T00:00:00.000Z' } } })
  state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(state.explainerVisitedAt?.toISOString(), '2026-10-03T00:00:00.000Z')
  assert.notEqual(activity.nextActivity(state, UP).kind, 'explainer')
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

dbTest('old teach-back and hard-quiz evidence is found past any window of newer rows', async () => {
  const w = await world()
  const old = new Date('2026-01-01T00:00:00Z')
  const day = 86_400_000
  const hardSet = await prisma.topicQuiz.create({ data: { topicId: w.topic.id, kind: 'standard', questions: [{ question_text: 'q', difficulty: 'hard' }] } })
  const easySet = await prisma.topicQuiz.create({ data: { topicId: w.topic.id, kind: 'standard', questions: [{ question_text: 'q', difficulty: 'easy' }] } })
  await prisma.quizAttempt.create({ data: { userId: w.user.id, topicId: w.topic.id, quizSetId: hardSet.id, answers: {}, results: {}, score: 50, takenAt: old } })
  await prisma.quizAttempt.createMany({
    data: Array.from({ length: 40 }, (_, i) => ({ userId: w.user.id, topicId: w.topic.id, quizSetId: easySet.id, answers: {}, results: {}, score: 50, takenAt: new Date(old.getTime() + (i + 1) * day) })),
  })
  await prisma.recallAttempt.create({ data: { userId: w.user.id, topicId: w.topic.id, kind: 'teach_back', promptText: 'p', answerText: 'x', mode: 'text', result: {}, createdAt: old } })
  await prisma.recallAttempt.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({ userId: w.user.id, topicId: w.topic.id, kind: 'recall', promptText: 'p', answerText: 'x', mode: 'text', result: {}, createdAt: new Date(old.getTime() + (i + 1) * day) })),
  })
  const state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(state.lastHardQuizAt?.toISOString(), old.toISOString())
  assert.equal(state.lastTeachBackAt?.toISOString(), old.toISOString())
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

dbTest('the easier step since a fail: a delivered worked example or a drill on the concept, after the last fail', async () => {
  const w = await world()
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const a = await prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name: 'A', summary: 's', kind: 'concept', orderIndex: 0 } })
  const evidence = await import('./evidence')
  const instruction = await import('./instruction')
  const day = 86_400_000
  const t0 = Date.now() - 4 * day
  const fail = (user: typeof w, conceptId: string, n: number) => ({
    userId: user.user.id, projectId: user.project.id, topicId: user.topic.id, itemKey: `quiz:f${n}:0`, conceptIds: [conceptId], source: 'quiz' as const,
    score: 0, assistance: 0 as const, gradedBy: 'rule' as const, sessionKey: `f${n}`, at: new Date(t0 + n * day),
  })
  await evidence.recordEvidence([fail(w, a.id, 0)], { timeZone: 'UTC' })
  await evidence.recordEvidence([fail(w, a.id, 1)], { timeZone: 'UTC' })
  const load = (user: typeof w) => server.loadTopicLearningState({ userId: user.user.id, topicId: user.topic.id, now: new Date(), timeZone: 'UTC' })
  let c = (await load(w)).concepts[0]
  assert.equal(c.consecutiveFails, 2)
  assert.equal(c.easierStepSinceFail, false)

  // A worked example before the last fail does not count; one after it does.
  const worked = (ref: string, at: Date) => instruction.instructionInput('worked_example', { userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, conceptIds: [a.id], ref, at })
  await evidence.recordEvidence([worked('x', new Date(t0 + 0.5 * day))], { timeZone: 'UTC' })
  assert.equal((await load(w)).concepts[0].easierStepSinceFail, false)
  await evidence.recordEvidence([worked('y', new Date(t0 + 1.5 * day))], { timeZone: 'UTC' })
  c = (await load(w)).concepts[0]
  assert.equal(c.easierStepSinceFail, true)
  assert.equal(c.needsInstruction, false)

  // A drill session on the concept after the last fail counts as well.
  const other = await world()
  await prisma.topic.update({ where: { id: other.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const o = await prisma.concept.create({ data: { projectId: other.project.id, topicId: other.topic.id, name: 'O', summary: 's', kind: 'concept', orderIndex: 0 } })
  for (const n of [0, 1]) await evidence.recordEvidence([fail(other, o.id, n)], { timeZone: 'UTC' })
  assert.equal((await load(other)).concepts[0].easierStepSinceFail, false)
  await prisma.itemSession.create({ data: { userId: other.user.id, projectId: other.project.id, kind: 'drill', topicIds: [other.topic.id], items: [], answers: {}, results: { scope: { conceptId: o.id } } } })
  assert.equal((await load(other)).concepts[0].easierStepSinceFail, true)
})
