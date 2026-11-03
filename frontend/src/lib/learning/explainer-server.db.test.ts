/**
 * The explainer's gate, its gap explanations and its check blocks against a real, migrated Postgres (DATABASE_URL).
 * Skipped when no database with the recall_attempts table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let explainer: typeof import('./explainer-server')
let nextActivity: typeof import('./next-activity-server')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  explainer = await import('./explainer-server')
  nextActivity = await import('./next-activity-server')
  available = await prisma.$queryRaw`SELECT 1 FROM recall_attempts LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

/** Two concepts with a claim each; `claims: false` makes a topic with nothing to recall. */
async function world(label: string, options: { claims?: boolean; backfilled?: boolean } = {}) {
  const user = await prisma.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true, ...(options.backfilled === false ? {} : { evidenceBackfilledAt: new Date() }) } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'notes.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  const concepts = []
  for (const [orderIndex, name] of ['Collision', 'Load factor'].entries()) {
    const concept = await prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name, summary: `${name}.`, kind: 'concept', orderIndex, objectiveIndexes: [orderIndex] } })
    const claim =
      options.claims === false
        ? null
        : await prisma.conceptClaim.create({ data: { conceptId: concept.id, text: `${name} claim`, quote: `${name} quote`, materialId: material.id, orderIndex: 0, pageStart: 4 + orderIndex } })
    concepts.push({ ...concept, claim })
  }
  return { user, project, topic, concepts }
}

type World = Awaited<ReturnType<typeof world>>

const progress = (w: World, data: Record<string, unknown>) =>
  prisma.topicProgress.upsert({
    where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } },
    create: { topicId: w.topic.id, userId: w.user.id, ...data },
    update: data,
  })

const attemptWith = (w: World, verdicts: string[], extra: Record<string, unknown> = {}) =>
  prisma.recallAttempt.create({
    data: {
      userId: w.user.id,
      topicId: w.topic.id,
      kind: 'recall',
      promptText: 'Explain.',
      objectiveIndex: 0,
      answerText: 'my answer',
      mode: 'text',
      result: { status: 'graded', claims: w.concepts.map((c, i) => ({ claim_id: c.claim?.id, concept_id: c.id, verdict: verdicts[i] ?? 'covered' })) },
      ...extra,
    },
  })

test('asked unlock records reason asked, and the unlock needs the topic read', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-locked')
  assert.deepEqual(await explainer.explainerAccess(w.user.id, w.topic.id), { open: false, why: null, canUnlock: false })
  assert.deepEqual(await explainer.unlockExplainer({ userId: w.user.id, topicId: w.topic.id }), { status: 'read_first' })
  const row = await prisma.topicProgress.findUnique({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(row?.explainerUnlockedAt ?? null, null)

  // Warming up is not reading.
  await progress(w, { warmupAt: new Date() })
  assert.equal((await explainer.explainerAccess(w.user.id, w.topic.id))?.canUnlock, false)

  await progress(w, { readAt: new Date() })
  assert.deepEqual(await explainer.explainerAccess(w.user.id, w.topic.id), { open: false, why: null, canUnlock: true })
  assert.deepEqual(await explainer.unlockExplainer({ userId: w.user.id, topicId: w.topic.id }), { status: 'ok' })
  const unlocked = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(unlocked.explainerUnlockReason, 'asked')
  assert.ok(unlocked.explainerUnlockedAt)
  assert.equal((await explainer.explainerAccess(w.user.id, w.topic.id))?.open, true)

  // Asking again keeps the first unlock.
  await explainer.unlockExplainer({ userId: w.user.id, topicId: w.topic.id })
  const again = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(again.explainerUnlockedAt?.getTime(), unlocked.explainerUnlockedAt?.getTime())
})

test('a recall opens the explainer, and nobody else can see the topic', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-recalled')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  assert.deepEqual(await explainer.explainerAccess(w.user.id, w.topic.id), { open: true, why: 'recalled', canUnlock: true })
  const other = await world('ex-other')
  assert.equal(await explainer.explainerAccess(other.user.id, w.topic.id), null)
  assert.deepEqual(await explainer.unlockExplainer({ userId: other.user.id, topicId: w.topic.id }), { status: 'not_found' })
})

test('a topic with no recall to do is not locked', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  // Concepts without claims: recall has nothing to grade against.
  const noClaims = await world('ex-noclaims', { claims: false })
  assert.deepEqual(await explainer.explainerAccess(noClaims.user.id, noClaims.topic.id), { open: true, why: 'no_recall', canUnlock: true })
  // No concepts at all (from before v3, or extraction failed).
  const bare = await world('ex-bare')
  await prisma.conceptClaim.deleteMany({ where: { concept: { topicId: bare.topic.id } } })
  await prisma.concept.deleteMany({ where: { topicId: bare.topic.id } })
  assert.equal((await explainer.explainerAccess(bare.user.id, bare.topic.id))?.why, 'no_recall')
})

test('a topic whose history is not converted yet stays locked: a slow backfill does not open the explainer', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const pending = await world('ex-pending', { backfilled: false })
  assert.equal(await explainer.hasRecallPath(pending.topic.id), false, 'recall is not offered yet')
  assert.deepEqual(await explainer.explainerAccess(pending.user.id, pending.topic.id), { open: false, why: null, canUnlock: false })
  // Once converted, nothing about the gate changes.
  await prisma.topic.update({ where: { id: pending.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  assert.deepEqual(await explainer.explainerAccess(pending.user.id, pending.topic.id), { open: false, why: null, canUnlock: false })
})

test('a topic read before v3 reads as read, and as recalled when it was studied', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-legacy')
  await progress(w, { notesCompleted: true, lastAccessedAt: new Date() })
  // Read before v3, nothing else on record: still locked, and the thin-source way on is open.
  assert.deepEqual(await explainer.explainerAccess(w.user.id, w.topic.id), { open: false, why: null, canUnlock: true })
  // A finished quiz shows it was studied.
  await prisma.quizAttempt.create({ data: { userId: w.user.id, topicId: w.topic.id, score: 80, answers: {}, results: [] } })
  assert.deepEqual(await explainer.explainerAccess(w.user.id, w.topic.id), { open: true, why: 'recalled', canUnlock: true })
})

test('gap explanations: none, pending, failed, ready', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-gaps')
  assert.equal((await explainer.loadGapExplainer(w.user.id, w.topic.id)).status, 'none')

  // Everything covered: no gap.
  await attemptWith(w, ['covered', 'partial'], { createdAt: new Date(Date.now() - 1_200_000) })
  assert.equal((await explainer.loadGapExplainer(w.user.id, w.topic.id)).status, 'none')

  // A missed claim, no explanation and no job: failed, and the attempt is the one to write again.
  const attempt = await attemptWith(w, ['covered', 'missing'], { createdAt: new Date(Date.now() - 600_000) })
  const failed = await explainer.loadGapExplainer(w.user.id, w.topic.id)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.missing, [attempt.id])

  // A job working on it: pending.
  const job = await prisma.processingJob.create({
    data: { userId: w.user.id, projectId: w.project.id, jobType: 'gap_explainer', status: 'processing', inputData: { attemptId: attempt.id }, targetKey: `gap-explainer:${attempt.id}` },
  })
  assert.equal((await explainer.loadGapExplainer(w.user.id, w.topic.id)).status, 'pending')
  await prisma.processingJob.update({ where: { id: job.id }, data: { status: 'completed' } })

  // Written: the gap, with its check and its page.
  const claim = w.concepts[1].claim
  await prisma.recallAttempt.update({
    where: { id: attempt.id },
    data: {
      explainer: {
        status: 'ready',
        gaps: [{ claim_id: claim?.id, concept_id: w.concepts[1].id, concept_name: 'Load factor', explanation: 'It is entries over buckets.', check: { question: 'What is the load factor?', answer: 'Entries over buckets.' }, source: { material_id: claim?.materialId, filename: 'notes.pdf', page: 5 } }],
        skipped: [{ claim_id: 'gone', concept_name: 'Other', source: { filename: 'notes.pdf', page: 7 } }],
      },
    },
  })
  const ready = await explainer.loadGapExplainer(w.user.id, w.topic.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.gaps.length, 1)
  assert.equal(ready.gaps[0].conceptName, 'Load factor')
  assert.equal(ready.gaps[0].check.question, 'What is the load factor?')
  assert.equal(ready.gaps[0].source.page, 5)
  assert.equal(ready.skipped[0].source.page, 7)
  assert.deepEqual(ready.missing, [])
})

test('opening the explainer is a visit that next-activity reads, and the first visit stands', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-visit')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  const attempt = await attemptWith(w, ['covered', 'missing'])
  assert.equal((await nextActivity.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })).explainerVisitedAt, null)

  await explainer.markExplainerViewed(w.user.id, w.topic.id)
  const first = await prisma.recallAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
  const viewedAt = (first.explainer as { viewedAt?: string }).viewedAt
  assert.ok(viewedAt)
  assert.ok((await nextActivity.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })).explainerVisitedAt)

  // A later visit changes nothing, and a gap explainer written afterwards keeps the visit.
  await explainer.markExplainerViewed(w.user.id, w.topic.id)
  await prisma.$executeRaw`UPDATE recall_attempts SET explainer = COALESCE(explainer, '{}'::jsonb) || '{"status":"ready","gaps":[],"skipped":[]}'::jsonb WHERE id = ${attempt.id}`
  const second = await prisma.recallAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
  assert.equal((second.explainer as { viewedAt?: string }).viewedAt, viewedAt)
  assert.equal((second.explainer as { status?: string }).status, 'ready')
})

test('a graded check is level-2 example evidence for display, once per question', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-check')
  const input = { userId: w.user.id, topicId: w.topic.id, question: 'Why does a Collision need a list in the bucket?', grade: 'partly' as const, idk: false, conceptId: null, timeZone: 'UTC' }

  const first = await explainer.recordExplainerCheck(input)
  assert.deepEqual(first, { status: 'ok', recorded: true })
  const rows = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'example' } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].conceptId, w.concepts[0].id) // the concept the question names
  assert.equal(rows[0].assistance, 2)
  assert.equal(rows[0].gradedBy, 'self')
  assert.equal(rows[0].score, 0.5)
  assert.equal(rows[0].itemKey, explainer.checkItemKey(w.topic.id, input.question))

  // Level 2 never moves the memory.
  const memory = await prisma.conceptMemory.findUnique({ where: { userId_conceptId: { userId: w.user.id, conceptId: w.concepts[0].id } } })
  assert.equal(memory?.nUnassisted ?? 0, 0)
  assert.equal(memory?.nAssisted, 1)

  // Grading the same question again (a new session) is not counted twice, however it is spaced or cased.
  assert.deepEqual(await explainer.recordExplainerCheck({ ...input, question: '  why does a  collision need a list in the bucket? ', grade: 'got_it' }), { status: 'ok', recorded: false })
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'example' } }), 1)
})

test('a gap check is filed under its concept, and a question that names none is not filed', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-check-concept')
  const base = { userId: w.user.id, topicId: w.topic.id, grade: 'missed' as const, idk: true, timeZone: 'UTC' }
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'What is it?', conceptId: w.concepts[1].id }), { status: 'ok', recorded: true })
  const row = await prisma.evidenceEvent.findFirstOrThrow({ where: { userId: w.user.id, source: 'example' } })
  assert.equal(row.conceptId, w.concepts[1].id)
  assert.equal((row.metadata as Record<string, unknown>).idk, true)

  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'Something unrelated?', conceptId: null }), { status: 'ok', recorded: false })
  // A concept of another topic is refused.
  const other = await world('ex-check-other')
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'Another?', conceptId: other.concepts[0].id }), { status: 'not_found' })
  const stranger = await world('ex-check-stranger')
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, userId: stranger.user.id, question: 'Hello?', conceptId: null }), { status: 'not_found' })
})

test('a lesson question is filed under a concept only when it names one clearly', () => {
  const concepts = [
    { id: 'hash', name: 'Hash' },
    { id: 'hash-function', name: 'Hash function' },
    { id: 'cat', name: 'Cat' },
    { id: 'load', name: 'Load factor' },
    { id: 'c', name: 'C++' },
  ]
  const named = explainer?.conceptsNamedIn
  // A short name inside a longer word is not named.
  assert.deepEqual(named('What is a category?', concepts), [])
  assert.deepEqual(named('Why does the Cat sit?', concepts), ['cat'])
  // Case does not matter.
  assert.deepEqual(named('what is the LOAD FACTOR?', concepts), ['load'])
  // A name inside a longer matching name belongs to the longer one.
  assert.deepEqual(named('What does a hash function do?', concepts), ['hash-function'])
  assert.deepEqual(named('What is a hash?', concepts), ['hash'])
  // Two different concepts named: ambiguous, not filed.
  assert.deepEqual(named('How does the Cat relate to the load factor?', concepts), [])
  // Names with regex characters are matched as written.
  assert.deepEqual(named('Why is C++ fast?', concepts), ['c'])
})

test('the gap explanations shown are level-3 help, once per attempt; the full explainer writes nothing', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-shown')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  const claim = w.concepts[1].claim
  const attempt = await attemptWith(w, ['covered', 'missing'], {
    explainer: {
      status: 'ready',
      gaps: [{ claim_id: claim?.id, concept_id: w.concepts[1].id, concept_name: 'Load factor', explanation: 'It is entries over buckets.', check: { question: 'What is it?', answer: 'Entries over buckets.' }, source: { filename: 'notes.pdf', page: 5 } }],
      skipped: [],
    },
  })
  // Opening the explainer (the visit) writes no evidence.
  await explainer.markExplainerViewed(w.user.id, w.topic.id)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)

  assert.equal(await explainer.recordGapsShown({ userId: w.user.id, topicId: w.topic.id, timeZone: 'UTC' }), 1)
  const rows = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].conceptId, w.concepts[1].id)
  assert.equal(rows[0].assistance, 3)
  assert.equal(rows[0].source, 'example')
  assert.equal(rows[0].score, 0)
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: w.concepts[1].id } } })
  assert.ok(memory.lastAssistedAt)
  assert.equal(memory.nUnassisted, 0)

  // Showing them again, or again after a reload, is not a second record.
  assert.equal(await explainer.recordGapsShown({ userId: w.user.id, topicId: w.topic.id, timeZone: 'UTC' }), 0)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 1)
  const stored = (await prisma.recallAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).explainer as Record<string, unknown>
  assert.ok(stored.gapsShownAt)
  assert.ok(stored.viewedAt)
})

test('"I don\'t know" is a miss whatever grade is sent', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-idk')
  await explainer.recordExplainerCheck({ userId: w.user.id, topicId: w.topic.id, question: 'What is a Collision?', grade: 'got_it', idk: true, conceptId: null, timeZone: 'UTC' })
  const row = await prisma.evidenceEvent.findFirstOrThrow({ where: { userId: w.user.id, source: 'example' } })
  assert.equal(row.score, 0)
  assert.equal((row.metadata as Record<string, unknown>).grade, 'missed')
})

test('an answer given with the reading open is left out: it gets no explainer and does not hide the attempt before it', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-abandoned')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  // The earlier attempt has a gap and no explainer, answered long ago: it is the one to write.
  const earlier = await attemptWith(w, ['covered', 'missing'], { createdAt: new Date(Date.now() - 600_000) })
  const abandoned = await prisma.recallAttempt.create({
    data: {
      userId: w.user.id, topicId: w.topic.id, kind: 'recall', promptText: 'Explain.', objectiveIndex: 0, answerText: 'copied', mode: 'text',
      result: { status: 'graded', abandoned: true, claims: w.concepts.map((c) => ({ claim_id: c.claim?.id, concept_id: c.id, verdict: 'covered' })) },
    },
  })
  const state = await explainer.loadGapExplainer(w.user.id, w.topic.id)
  assert.equal(state.status, 'failed')
  assert.deepEqual(state.missing, [earlier.id])
  await explainer.markExplainerViewed(w.user.id, w.topic.id)
  assert.equal((await prisma.recallAttempt.findUniqueOrThrow({ where: { id: abandoned.id } })).explainer, null)
})

test('next-activity reads the visit from the same attempts the explainer writes it on', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-visit-set')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  await attemptWith(w, ['covered', 'missing'], { createdAt: new Date(Date.now() - 600_000) })
  // A newer answer given with the reading open: not a recall, and it must not stand in for the one before it.
  await prisma.recallAttempt.create({
    data: { userId: w.user.id, topicId: w.topic.id, kind: 'recall', promptText: 'Explain.', objectiveIndex: 0, answerText: 'copied', mode: 'text', result: { status: 'graded', abandoned: true, claims: [] } },
  })
  await explainer.markExplainerViewed(w.user.id, w.topic.id)
  assert.ok((await nextActivity.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })).explainerVisitedAt)
  // A card answered after the visit has none yet: the gap still wants a visit.
  await prisma.recallAttempt.create({
    data: { userId: w.user.id, topicId: w.topic.id, kind: 'recall', promptText: 'Explain.', objectiveIndex: 1, answerText: 'x', mode: 'text', result: { status: 'graded', claims: [{ claim_id: w.concepts[1].claim?.id, concept_id: w.concepts[1].id, verdict: 'missing' }] } },
  })
  assert.equal((await nextActivity.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })).explainerVisitedAt, null)
})

test('a topic whose concepts finished after the overview was opened is converted when the topic is opened', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const backfill = await import('./backfill')
  const w = await world('ex-convert', { backfilled: false })
  // Before: the path has no Recall, and the explainer is not behind it.
  assert.equal(await explainer.hasRecallPath(w.topic.id), false)
  assert.equal(await backfill.convertTopicIfDue(w.user.id, w.project.id, w.topic.id), true)
  // After: converted, so Recall has a card and the explainer is locked.
  assert.ok((await prisma.topic.findUniqueOrThrow({ where: { id: w.topic.id } })).evidenceBackfilledAt)
  assert.equal(await explainer.hasRecallPath(w.topic.id), true)
  assert.equal((await explainer.explainerAccess(w.user.id, w.topic.id))?.open, false)
  assert.equal((await nextActivity.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })).concepts.length, 2)
  // Done once: nothing more to do, and a topic without concepts is left alone.
  assert.equal(await backfill.convertTopicIfDue(w.user.id, w.project.id, w.topic.id), false)
  const bare = await world('ex-convert-bare', { claims: false, backfilled: false })
  await prisma.concept.deleteMany({ where: { topicId: bare.topic.id } })
  assert.equal(await backfill.convertTopicIfDue(bare.user.id, bare.project.id, bare.topic.id), false)
})

test('an attempt answered a moment ago is being written, not lost', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-starting')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  await attemptWith(w, ['covered', 'missing'])
  assert.equal((await explainer.loadGapExplainer(w.user.id, w.topic.id)).status, 'pending')
})

test('the explainer is locked exactly when Recall has a card to show', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const recall = await import('./recall-server')
  // Claims, but the topic's history is not converted yet: the path has no Recall yet, and the explainer stays shut
  // until it does (a slow conversion must not open a lesson that recall comes before).
  const early = await world('ex-path-early', { backfilled: false })
  assert.equal(await explainer.hasRecallPath(early.topic.id), false)
  assert.equal((await explainer.explainerAccess(early.user.id, early.topic.id))?.open, false)
  // Converted, with claims: Recall has a card, and the explainer waits for it.
  const ready = await world('ex-path-ready')
  assert.equal(await explainer.hasRecallPath(ready.topic.id), true)
  const state = await recall.loadRecallState(ready.user.id, ready.topic.id)
  assert.ok(state && state.cards.length > 0)
  assert.equal((await explainer.explainerAccess(ready.user.id, ready.topic.id))?.open, false)
  // Converted but nothing to grade against: no card and no gate.
  const bare = await world('ex-path-bare', { claims: false })
  assert.equal(await explainer.hasRecallPath(bare.topic.id), false)
  assert.equal((await recall.loadRecallState(bare.user.id, bare.topic.id))?.cards.length, 0)
  assert.equal((await explainer.explainerAccess(bare.user.id, bare.topic.id))?.open, true)
})

test('a worked-example check is filed under the example concept ids even when its question names no concept', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-check-ids')
  const base = { userId: w.user.id, topicId: w.topic.id, grade: 'got_it' as const, idk: false, conceptId: null, timeZone: 'UTC' }
  const question = 'What is step 2 of the worked example "Alpha"?'
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question, conceptIds: [w.concepts[0].id, w.concepts[1].id] }), { status: 'ok', recorded: true })
  const rows = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'example' }, orderBy: { conceptId: 'asc' } })
  assert.deepEqual(rows.map((row) => row.conceptId).sort(), [w.concepts[0].id, w.concepts[1].id].sort())
  assert.ok(rows.every((row) => row.assistance === 2 && row.gradedBy === 'self'))
  // The same question again is not counted twice; a concept of another topic is refused.
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question, conceptIds: [w.concepts[0].id] }), { status: 'ok', recorded: false })
  const other = await world('ex-check-ids-other')
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'Another step?', conceptIds: [other.concepts[0].id] }), { status: 'not_found' })
  // With no ids the question's names decide, as before.
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'A step that names nothing?', conceptIds: [] }), { status: 'ok', recorded: false })
})

test('a check that names an archived or merged concept is filed under what is left, or not counted', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-check-stale')
  const [a, b] = w.concepts
  const extra = await prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name: 'Probing', summary: 'Probing.', kind: 'concept', orderIndex: 2, objectiveIndexes: [] } })
  // The first concept was merged into the second; the extra one was archived.
  await prisma.concept.update({ where: { id: a.id }, data: { status: 'archived', mergedIntoId: b.id } })
  await prisma.concept.update({ where: { id: extra.id }, data: { status: 'archived' } })
  const base = { userId: w.user.id, topicId: w.topic.id, grade: 'got_it' as const, idk: false, conceptId: null, timeZone: 'UTC' }

  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'Step one?', conceptIds: [a.id, extra.id, b.id] }), { status: 'ok', recorded: true })
  const rows = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'example' } })
  assert.deepEqual(rows.map((row) => row.conceptId), [b.id])

  // A single concept id that was merged follows the merge; one that was archived is not counted.
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'Gap one?', conceptId: a.id }), { status: 'ok', recorded: true })
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'Step two?', conceptIds: [extra.id] }), { status: 'ok', recorded: false })
  assert.deepEqual(await explainer.recordExplainerCheck({ ...base, question: 'Gap two?', conceptId: extra.id }), { status: 'ok', recorded: false })
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'example' } }), 2)
})

test('explainer view writes one instruction event per concept per day', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-viewed')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  const ids = w.concepts.map((c) => c.id)
  const instruction = () => prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'instruction' }, orderBy: { conceptId: 'asc' } })

  assert.equal(await explainer.explainerViewed(w.user.id, w.topic.id, { conceptIds: ids, kind: 'gap_explainer', timeZone: 'UTC' }), 2)
  const first = await instruction()
  assert.deepEqual(first.map((row) => row.conceptId).sort(), [...ids].sort())
  assert.ok(first.every((row) => row.assistance === 3 && row.weight === 0 && row.itemKey.startsWith('instruction:gap_explainer:')))

  // The same sections shown again the same day change nothing; the other form of the explainer is its own instruction.
  assert.equal(await explainer.explainerViewed(w.user.id, w.topic.id, { conceptIds: ids, kind: 'gap_explainer', timeZone: 'UTC' }), 0)
  assert.equal((await instruction()).length, 2)
  assert.equal(await explainer.explainerViewed(w.user.id, w.topic.id, { conceptIds: [ids[0]], kind: 'full_explainer', timeZone: 'UTC' }), 1)
  assert.equal((await instruction()).length, 3)

  // Another student's concept writes nothing; neither does another student's topic.
  const other = await world('ex-viewed-other')
  assert.equal(await explainer.explainerViewed(w.user.id, w.topic.id, { conceptIds: [other.concepts[0].id], kind: 'gap_explainer', timeZone: 'UTC' }), 0)
  assert.equal(await explainer.explainerViewed(other.user.id, w.topic.id, { conceptIds: ids, kind: 'gap_explainer', timeZone: 'UTC' }), 0)
})

test('a full-explainer section is filed under the one concept its heading names', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-heading')
  assert.equal(await explainer.explainerViewed(w.user.id, w.topic.id, { heading: 'How a collision happens', kind: 'full_explainer', timeZone: 'UTC' }), 1)
  const rows = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'instruction' } })
  assert.deepEqual(rows.map((row) => row.conceptId), [w.concepts[0].id])
  // A heading that names none, or two, is filed under none.
  assert.equal(await explainer.explainerViewed(w.user.id, w.topic.id, { heading: 'Summary', kind: 'full_explainer', timeZone: 'UTC' }), 0)
  assert.equal(await explainer.explainerViewed(w.user.id, w.topic.id, { heading: 'Collision and load factor', kind: 'full_explainer', timeZone: 'UTC' }), 0)
})
