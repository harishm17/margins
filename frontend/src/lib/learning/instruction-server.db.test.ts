/**
 * Instruction events and what every surface shows after a miss (spec 18.3, 18.5), against a real, migrated
 * Postgres (DATABASE_URL). Skipped when no database with the evidence_events table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let server: typeof import('./instruction-server')
let evidence: typeof import('./evidence')
let loader: typeof import('./next-activity-server')
let activity: typeof import('./next-activity')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  server = await import('./instruction-server')
  evidence = await import('./evidence')
  loader = await import('./next-activity-server')
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

const DAY = 24 * 60 * 60 * 1000
const UP = { ai: 'up' as const, now: new Date(), timeZone: 'UTC' }

async function world() {
  const user = await prisma.user.create({ data: { email: `is-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true, evidenceBackfilledAt: new Date() } })
  const mk = (name: string, orderIndex: number, topicId = topic.id) =>
    prisma.concept.create({ data: { projectId: project.id, topicId, name, summary: 's', kind: 'concept', orderIndex } })
  const material = await prisma.material.create({ data: { projectId: project.id, category: 'lecture_notes', filename: 'notes.pdf', gcsPath: 'x', sizeBytes: 1 } })
  return { user, project, topic, mk, material }
}
type World = Awaited<ReturnType<typeof world>>

const miss = (w: World, conceptId: string, n = 0, over: object = {}) => ({
  userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, itemKey: `quiz:m${n}:${conceptId}`, conceptIds: [conceptId], source: 'quiz' as const,
  score: 0, assistance: 0 as const, gradedBy: 'rule' as const, sessionKey: `m${n}-${conceptId}`, ...over,
})

const events = (w: World, source = 'instruction') => prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source }, orderBy: { createdAt: 'asc' } })

dbTest('pointers come from first claims with page and chunk', async () => {
  const w = await world()
  const a = await w.mk('Hash tables', 0)
  const b = await w.mk('Trees', 1)
  const c = await w.mk('Graphs', 2)
  await prisma.conceptClaim.create({ data: { conceptId: a.id, text: 'late', quote: 'q', materialId: w.material.id, chunkId: 'chunk-9', pageStart: 9, pageEnd: 9, orderIndex: 3 } })
  await prisma.conceptClaim.create({ data: { conceptId: a.id, text: 'first', quote: 'q', materialId: w.material.id, chunkId: 'chunk-3', pageStart: 3, pageEnd: 4, orderIndex: 0 } })
  await prisma.conceptClaim.create({ data: { conceptId: b.id, text: 'no chunk', quote: 'q', materialId: w.material.id, chunkId: null, pageStart: 12, pageEnd: 12, orderIndex: 0 } })
  const help = await server.helpAfterMiss(prisma, { userId: w.user.id, topicId: w.topic.id, conceptIds: [a.id, b.id, c.id], surface: 'quiz' })
  assert.equal(help.pointers.length, 3)
  const base = `/courses/${w.project.id}/topics/${w.topic.id}`
  assert.deepEqual(help.pointers[0], { conceptId: a.id, conceptName: 'Hash tables', page: 3, chunkId: 'chunk-3', href: `${base}?view=read&focus=${a.id}#chunk-chunk-3` })
  assert.deepEqual(help.pointers[1], { conceptId: b.id, conceptName: 'Trees', page: 12, chunkId: null, href: `${base}?view=read&focus=${b.id}` })
  // A concept with no claim still gets a pointer at the concept, with no page.
  assert.deepEqual(help.pointers[2], { conceptId: c.id, conceptName: 'Graphs', page: null, chunkId: null, href: `${base}?view=read&focus=${c.id}` })
})

dbTest('the explainer is offered when a recall left a gap on the concepts, ready or not', async () => {
  const w = await world()
  const a = await w.mk('A', 0)
  const b = await w.mk('B', 1)
  const ask = (ids: string[]) => server.helpAfterMiss(prisma, { userId: w.user.id, topicId: w.topic.id, conceptIds: ids, surface: 'recall' })
  assert.equal((await ask([a.id])).explainer, null)

  await prisma.recallAttempt.create({
    data: { userId: w.user.id, topicId: w.topic.id, kind: 'recall', promptText: 'p', answerText: 'x', mode: 'text', result: { claims: [{ concept_id: a.id, verdict: 'missing' }] } },
  })
  const base = `/courses/${w.project.id}/topics/${w.topic.id}`
  assert.deepEqual((await ask([a.id])).explainer, { href: `${base}?view=explainer&focus=${a.id}`, ready: false })
  assert.equal((await ask([b.id])).explainer, null)

  await prisma.recallAttempt.updateMany({
    where: { userId: w.user.id },
    data: { explainer: { status: 'ready', gaps: [{ claim_id: 'c', concept_id: a.id, concept_name: 'A', explanation: 'e', check: { question: 'q', answer: 'a' }, source: {} }] } },
  })
  assert.deepEqual((await ask([b.id, a.id])).explainer, { href: `${base}?view=explainer&focus=${a.id}`, ready: true })
})

dbTest('an easier step is offered only for band 0 or after two fails in a row', async () => {
  const w = await world()
  const strong = await w.mk('Strong', 0)
  const unknown = await w.mk('Unknown', 1)
  const stuck = await w.mk('Stuck', 2)
  const prerequisite = await w.mk('Basics', 3)
  await prisma.conceptEdge.create({ data: { projectId: w.project.id, sourceId: prerequisite.id, targetId: stuck.id, type: 'prerequisite', weight: 1, confidence: 0.9 } })
  const t0 = Date.now() - 6 * DAY
  const right = (conceptId: string, n: number) => miss(w, conceptId, n, { score: 1, at: new Date(t0 + n * DAY) })
  // Strong: three right answers on three days, nothing else: band 2.
  for (const n of [0, 1, 2]) await evidence.recordEvidence([right(strong.id, n)], { timeZone: 'UTC' })
  // Stuck: two fails in a row.
  for (const n of [0, 1]) await evidence.recordEvidence([miss(w, stuck.id, n, { at: new Date(t0 + n * DAY) })], { timeZone: 'UTC' })
  const ask = (ids: string[], surface: 'quiz' | 'practice' | 'review' = 'quiz') => server.helpAfterMiss(prisma, { userId: w.user.id, topicId: w.topic.id, conceptIds: ids, surface })

  assert.equal((await ask([strong.id])).easierStep, null)
  const base = `/courses/${w.project.id}/topics/${w.topic.id}`
  // No evidence: band 0, worked examples at full support.
  const examples = (await ask([unknown.id])).easierStep
  assert.equal(examples?.kind, 'examples')
  assert.equal(examples?.href, `${base}?view=examples&focus=${unknown.id}&fade=full`)
  assert.ok(examples?.label)
  // In practice, an easier problem; the weak prerequisite is drilled first when there is one.
  assert.equal((await ask([unknown.id], 'practice')).easierStep?.kind, 'easier_problem')
  const drill = (await ask([stuck.id], 'review')).easierStep
  assert.equal(drill?.kind, 'prerequisite')
  assert.equal(drill?.href, `/courses/${w.project.id}/review/session?concept=${prerequisite.id}`)
  assert.match(drill!.label, /Basics/)
})

dbTest('recordInstruction is idempotent per day', async () => {
  const w = await world()
  const a = await w.mk('A', 0)
  const b = await w.mk('B', 1)
  const input = { userId: w.user.id, topicId: w.topic.id, kind: 'pointer' as const, conceptIds: [a.id, b.id], ref: a.id, timeZone: 'UTC' }
  const day1 = new Date('2026-11-10T10:00:00Z')
  assert.deepEqual(await server.recordInstruction(prisma, { ...input, at: day1 }), { status: 'recorded' })
  assert.deepEqual(await server.recordInstruction(prisma, { ...input, at: new Date('2026-11-10T22:00:00Z') }), { status: 'present' })
  assert.equal((await events(w)).length, 2)
  // Another local day is another event, and another ref is another one.
  assert.deepEqual(await server.recordInstruction(prisma, { ...input, at: new Date('2026-11-11T10:00:00Z') }), { status: 'recorded' })
  assert.deepEqual(await server.recordInstruction(prisma, { ...input, ref: b.id, at: day1 }), { status: 'recorded' })
  assert.equal((await events(w)).length, 6)
  // Rows share a timestamp, so find this one by its key rather than by position.
  const row = (await events(w)).find((e) => e.itemKey === `instruction:pointer:${a.id}`)
  assert.ok(row)
  assert.deepEqual([row.source, row.assistance, row.score, row.weight, row.gradedBy], ['instruction', 3, 0, 0, 'rule'])
  assert.deepEqual(row.metadata, { kind: 'pointer' })
  // Two at once write once.
  const race = await Promise.all([1, 2, 3].map(() => server.recordInstruction(prisma, { ...input, ref: 'race', at: day1 })))
  assert.equal(race.filter((r) => r.status === 'recorded').length >= 1, true)
  assert.equal((await prisma.evidenceEvent.count({ where: { userId: w.user.id, itemKey: 'instruction:pointer:race' } })), 2)
})

dbTest('recordInstruction refuses a topic or concepts that are not the student\'s', async () => {
  const w = await world()
  const a = await w.mk('A', 0)
  const stranger = await world()
  const theirs = await stranger.mk('Theirs', 0)
  const base = { kind: 'pointer' as const, ref: 'x', timeZone: 'UTC' }
  assert.deepEqual(await server.recordInstruction(prisma, { ...base, userId: stranger.user.id, topicId: w.topic.id, conceptIds: [a.id] }), { status: 'invalid' })
  assert.deepEqual(await server.recordInstruction(prisma, { ...base, userId: w.user.id, topicId: w.topic.id, conceptIds: [theirs.id] }), { status: 'invalid' })
  assert.deepEqual(await server.recordInstruction(prisma, { ...base, userId: w.user.id, topicId: w.topic.id, conceptIds: [] }), { status: 'invalid' })
  // A mix keeps the student's own concept.
  assert.deepEqual(await server.recordInstruction(prisma, { ...base, userId: w.user.id, topicId: w.topic.id, conceptIds: [a.id, theirs.id] }), { status: 'recorded' })
  assert.equal((await events(w)).length, 1)
  assert.equal((await events(stranger)).length, 0)
})

dbTest('an instruction after a fail clears needsInstruction and sends the student to fresh retrieval', async () => {
  const w = await world()
  const a = await w.mk('A', 0)
  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, readAt: new Date(), recallAt: new Date() } })
  const failedAt = new Date(Date.now() - 3600_000)
  await evidence.recordEvidence([miss(w, a.id, 0, { at: failedAt })], { timeZone: 'UTC' })
  const load = () => loader.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id, timeZone: 'UTC' })
  let state = await load()
  assert.equal(state.concepts[0].needsInstruction, true)
  assert.equal(activity.nextActivity(state, UP).kind, 'instruct')

  await server.recordInstruction(prisma, { userId: w.user.id, topicId: w.topic.id, kind: 'pointer', conceptIds: [a.id], ref: a.id, timeZone: 'UTC' })
  state = await load()
  assert.equal(state.concepts[0].needsInstruction, false)
  // The fail scheduled the concept for tomorrow, so it is not due yet: practice, a different item, not the same retrieval.
  assert.equal(activity.nextActivity(state, UP).kind, 'practice')

  // The instruction moved no card, mastery or due date.
  const memory = await prisma.conceptMemory.findFirstOrThrow({ where: { userId: w.user.id, conceptId: a.id } })
  assert.equal(memory.nAssisted, 0)
  assert.equal(memory.nUnassisted, 1) // the failed quiz itself
  assert.equal(memory.mastery, 0)
})

dbTest('instruction events spread no FIRe credit', async () => {
  const w = await world()
  const whole = await w.mk('Whole', 0)
  const part = await w.mk('Part', 1)
  await prisma.conceptEdge.create({ data: { projectId: w.project.id, sourceId: whole.id, targetId: part.id, type: 'encompasses', weight: 1, confidence: 0.9, status: 'confirmed' } })
  // Control: a Good answer on the whole credits the part.
  await evidence.recordEvidence([miss(w, whole.id, 0, { score: 1 })], { timeZone: 'UTC' })
  assert.ok((await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'implicit', conceptId: part.id } })) > 0)

  const other = await world()
  const oWhole = await other.mk('Whole', 0)
  const oPart = await other.mk('Part', 1)
  await prisma.conceptEdge.create({ data: { projectId: other.project.id, sourceId: oWhole.id, targetId: oPart.id, type: 'encompasses', weight: 1, confidence: 0.9, status: 'confirmed' } })
  await server.recordInstruction(prisma, { userId: other.user.id, topicId: other.topic.id, kind: 'full_explainer', conceptIds: [oWhole.id], ref: 'topic', timeZone: 'UTC' })
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: other.user.id, source: 'implicit' } }), 0)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: other.user.id } }), 1)
  const memory = await prisma.conceptMemory.findMany({ where: { userId: other.user.id } })
  assert.ok(memory.every((m) => m.card === null && m.dueAt === null))
})

dbTest('an instruction alone is not evidence that the topic was studied', async () => {
  const w = await world()
  const a = await w.mk('A', 0)
  await server.recordInstruction(prisma, { userId: w.user.id, topicId: w.topic.id, kind: 'pointer', conceptIds: [a.id], ref: a.id, timeZone: 'UTC' })
  const state = await loader.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id, timeZone: 'UTC' })
  assert.equal(state.hasAnyEvidence, false)
  assert.equal(state.concepts[0].label, 'not_started')
  assert.equal(state.concepts[0].hasCard, false)
})
