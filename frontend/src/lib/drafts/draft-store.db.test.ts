/**
 * The draft store against a real, migrated Postgres (DATABASE_URL). Skipped when no database with the
 * study_drafts table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let store: typeof import('./draft-store')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  store = await import('./draft-store')
  available = await prisma.$queryRaw`SELECT 1 FROM study_drafts LIMIT 1`.then(
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

async function world() {
  const user = await prisma.user.create({ data: { email: `dr-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  return { user, project, topic }
}

type World = Awaited<ReturnType<typeof world>>
const recallInput = (w: World, text: string, version: number, key = `${w.topic.id}:obj0`) => ({
  surface: 'recall' as const,
  key,
  projectId: w.project.id,
  topicId: w.topic.id,
  payload: { text, voice: false },
  version,
})

dbTest('draft round trip', async () => {
  const w = await world()
  const first = await store.saveDraft(w.user.id, recallInput(w, 'hello', 0))
  assert.equal(first.status, 'saved')
  assert.ok(first.status === 'saved' && first.draft.version === 1)
  const second = await store.saveDraft(w.user.id, recallInput(w, 'hello world', 1))
  assert.ok(second.status === 'saved' && second.draft.version === 2)
  const loaded = await store.loadDraft(w.user.id, 'recall', `${w.topic.id}:obj0`)
  assert.deepEqual(loaded?.payload, { text: 'hello world', voice: false })
  assert.equal(loaded?.version, 2)
  await store.clearDraft(w.user.id, 'recall', `${w.topic.id}:obj0`)
  assert.equal(await store.loadDraft(w.user.id, 'recall', `${w.topic.id}:obj0`), null)
  // Clearing what is not there is fine.
  await store.clearDraft(w.user.id, 'recall', `${w.topic.id}:obj0`)
})

dbTest('stale version conflicts and returns the stored draft', async () => {
  const w = await world()
  await store.saveDraft(w.user.id, recallInput(w, 'one', 0))
  await store.saveDraft(w.user.id, recallInput(w, 'two', 1)) // another tab got there first
  const stale = await store.saveDraft(w.user.id, recallInput(w, 'mine', 1))
  assert.equal(stale.status, 'conflict')
  assert.ok(stale.status === 'conflict' && stale.draft?.version === 2)
  assert.deepEqual(stale.status === 'conflict' && stale.draft?.payload, { text: 'two', voice: false })
  // A create over an existing row conflicts too.
  const again = await store.saveDraft(w.user.id, recallInput(w, 'new', 0))
  assert.ok(again.status === 'conflict' && again.draft?.version === 2)
  // The stored text is untouched.
  assert.deepEqual((await store.loadDraft(w.user.id, 'recall', `${w.topic.id}:obj0`))?.payload, { text: 'two', voice: false })
})

dbTest('two saves at the same version: exactly one wins', async () => {
  const w = await world()
  await store.saveDraft(w.user.id, recallInput(w, 'base', 0))
  const results = await Promise.all([
    store.saveDraft(w.user.id, recallInput(w, 'tab A', 1)),
    store.saveDraft(w.user.id, recallInput(w, 'tab B', 1)),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), ['conflict', 'saved'])
  // Two creates at version 0 race the same way.
  const key = `${w.topic.id}:obj1`
  const creates = await Promise.all([
    store.saveDraft(w.user.id, recallInput(w, 'A', 0, key)),
    store.saveDraft(w.user.id, recallInput(w, 'B', 0, key)),
  ])
  assert.deepEqual(creates.map((r) => r.status).sort(), ['conflict', 'saved'])
})

dbTest('oversized payload rejected', async () => {
  const w = await world()
  const big = await store.saveDraft(w.user.id, recallInput(w, 'x'.repeat(17 * 1024), 0))
  assert.equal(big.status, 'too_large')
  // 16 KB exactly of a valid payload is allowed: {"text":"...","voice":false} has 25 bytes of frame.
  const fits = await store.saveDraft(w.user.id, { ...recallInput(w, '', 0), payload: { text: 'y'.repeat(11_000), voice: false } })
  assert.equal(fits.status, 'saved')
  assert.equal(await prisma.studyDraft.count({ where: { userId: w.user.id } }), 1)
  // Many multibyte characters: the cap is bytes, not characters.
  const multibyte = await store.saveDraft(w.user.id, recallInput(w, '\u{1F600}'.repeat(5000), 1))
  assert.equal(multibyte.status, 'too_large')
})

dbTest('payloads that do not match the surface are refused', async () => {
  const w = await world()
  const wrong = await store.saveDraft(w.user.id, { ...recallInput(w, '', 0), payload: { answer: 'not a recall draft' } })
  assert.equal(wrong.status, 'invalid')
  const badKey = await store.saveDraft(w.user.id, recallInput(w, 'a', 0, 'no-colon'))
  assert.equal(badKey.status, 'invalid')
  const otherTopic = await store.saveDraft(w.user.id, recallInput(w, 'a', 0, `${w.topic.id}x:obj0`))
  assert.equal(otherTopic.status, 'invalid')
  assert.equal(await prisma.studyDraft.count({ where: { userId: w.user.id } }), 0)
})

dbTest('an expired draft reads as absent and is removed; writing it again starts over', async () => {
  const w = await world()
  const t0 = new Date('2026-11-02T10:00:00Z')
  await store.saveDraft(w.user.id, recallInput(w, 'old', 0), { now: t0 })
  const later = new Date(t0.getTime() + 15 * DAY)
  assert.equal(await store.loadDraft(w.user.id, 'recall', `${w.topic.id}:obj0`, { now: later }), null)
  assert.equal(await prisma.studyDraft.count({ where: { userId: w.user.id } }), 0)
  await store.saveDraft(w.user.id, recallInput(w, 'old2', 0), { now: t0 })
  const created = await store.saveDraft(w.user.id, recallInput(w, 'fresh', 0), { now: later })
  assert.ok(created.status === 'saved' && created.draft.version === 1)
})

dbTest('another user cannot read, write or delete a draft', async () => {
  const a = await world()
  const b = await world()
  const key = `${a.topic.id}:obj0`
  await store.saveDraft(a.user.id, recallInput(a, 'private', 0))
  assert.equal(await store.loadDraft(b.user.id, 'recall', key), null)
  await store.clearDraft(b.user.id, 'recall', key)
  assert.equal((await store.loadDraft(a.user.id, 'recall', key))?.version, 1)
  // B writing into A's project is refused, and writes nothing.
  const forged = await store.saveDraft(b.user.id, recallInput(a, 'forged', 0))
  assert.equal(forged.status, 'not_found')
  // B using their own project but A's topic is refused too.
  const crossTopic = await store.saveDraft(b.user.id, { ...recallInput(a, 'x', 0), projectId: b.project.id })
  assert.equal(crossTopic.status, 'not_found')
  assert.equal(await prisma.studyDraft.count({ where: { userId: b.user.id } }), 0)
  // The same key under B's own account is a separate row.
  const own = await store.saveDraft(b.user.id, { ...recallInput(b, 'mine', 0), key: `${b.topic.id}:obj0` })
  assert.equal(own.status, 'saved')
})

async function quizWorld() {
  const w = await world()
  const set = await prisma.topicQuiz.create({ data: { topicId: w.topic.id, questions: [], kind: 'standard' } })
  return { ...w, set }
}
const quizInput = (w: Awaited<ReturnType<typeof quizWorld>>, version: number, answered = 1) => ({
  surface: 'quiz' as const,
  key: `${w.topic.id}:${w.set.id}`,
  projectId: w.project.id,
  topicId: w.topic.id,
  payload: { answers: Object.fromEntries(Array.from({ length: answered }, (_, i) => [String(i), { answer: 'B' }])), index: answered },
  version,
})
const attempt = (w: Awaited<ReturnType<typeof quizWorld>>, takenAt: Date) =>
  prisma.quizAttempt.create({ data: { userId: w.user.id, topicId: w.topic.id, quizSetId: w.set.id, answers: {}, results: {}, score: 50, takenAt } })

dbTest('quiz draft for a set taken today is refused', async () => {
  const w = await quizWorld()
  const now = new Date('2026-11-02T20:00:00Z')
  await attempt(w, new Date('2026-11-02T15:00:00Z'))
  const refused = await store.saveDraft(w.user.id, quizInput(w, 0), { now, timeZone: 'America/Los_Angeles' })
  assert.equal(refused.status, 'retry_tomorrow')
  // Opens at the next local midnight: 2026-11-03 00:00 in Los Angeles (UTC-8 after the DST change).
  assert.ok(refused.status === 'retry_tomorrow' && refused.opensAt.toISOString() === '2026-11-03T08:00:00.000Z')
  assert.equal(await prisma.studyDraft.count({ where: { userId: w.user.id } }), 0)
})

dbTest('an attempt at another set does not block, and a waiting submission counts as taken', async () => {
  const w = await quizWorld()
  const other = await prisma.topicQuiz.create({ data: { topicId: w.topic.id, questions: [], kind: 'standard' } })
  await prisma.quizAttempt.create({ data: { userId: w.user.id, topicId: w.topic.id, quizSetId: other.id, answers: {}, results: {}, score: 1, takenAt: new Date() } })
  assert.equal((await store.saveDraft(w.user.id, quizInput(w, 0))).status, 'saved')
  await store.clearDraft(w.user.id, 'quiz', `${w.topic.id}:${w.set.id}`)
  await prisma.quizSubmission.create({ data: { userId: w.user.id, topicId: w.topic.id, quizSetId: w.set.id, answers: {}, questions: [], status: 'pending', submittedAt: new Date() } })
  assert.equal((await store.saveDraft(w.user.id, quizInput(w, 0))).status, 'retry_tomorrow')
})

dbTest('resuming an existing quiz draft is never refused', async () => {
  const w = await quizWorld()
  assert.equal((await store.saveDraft(w.user.id, quizInput(w, 0, 1))).status, 'saved')
  await attempt(w, new Date()) // submitted from an older client, or in another tab
  const resumed = await store.saveDraft(w.user.id, quizInput(w, 1, 3))
  assert.ok(resumed.status === 'saved' && resumed.draft.version === 2)
  assert.ok((await store.loadDraft(w.user.id, 'quiz', `${w.topic.id}:${w.set.id}`)))
})

dbTest('a quiz draft for a set that does not exist is refused, and one whose set was deleted is dropped on read', async () => {
  const w = await quizWorld()
  const missing = await store.saveDraft(w.user.id, { ...quizInput(w, 0), key: `${w.topic.id}:nosuchset` })
  assert.equal(missing.status, 'not_found')
  await store.saveDraft(w.user.id, quizInput(w, 0))
  await prisma.topicQuiz.delete({ where: { id: w.set.id } })
  assert.equal(await store.loadDraft(w.user.id, 'quiz', `${w.topic.id}:${w.set.id}`), null)
  assert.equal(await prisma.studyDraft.count({ where: { userId: w.user.id } }), 0)
})

dbTest('old quiz sessions with plain string answers are stored as objects', async () => {
  const w = await quizWorld()
  const saved = await store.saveDraft(w.user.id, { ...quizInput(w, 0), payload: { answers: { '0': 'A' }, index: 1 } })
  assert.ok(saved.status === 'saved')
  assert.deepEqual(saved.draft.payload, { answers: { '0': { answer: 'A' } }, index: 1 })
})

// The first quiz of a topic from before quiz sets lives only in topic_content; the view calls it 'legacy'.
async function legacyWorld() {
  const w = await world()
  const questions = [{ question_type: 'true_false', question_text: 'Q', points: 1, correct_answer: 'true' }]
  await prisma.topicContent.create({ data: { topicId: w.topic.id, contentType: 'topic_quiz', contentData: questions } })
  return w
}
const legacyInput = (w: World, version: number) => ({
  surface: 'quiz' as const,
  key: `${w.topic.id}:legacy`,
  projectId: w.project.id,
  topicId: w.topic.id,
  payload: { answers: { '0': { answer: 'true' } }, index: 1 },
  version,
})

dbTest('a legacy quiz draft needs the topic to have a first quiz, and is dropped once the topic has quiz sets', async () => {
  const bare = await world()
  assert.equal((await store.saveDraft(bare.user.id, legacyInput(bare, 0))).status, 'not_found')
  const w = await legacyWorld()
  await store.saveDraft(w.user.id, legacyInput(w, 0))
  // A new set copies the first quiz into its own row, so 'legacy' stops naming a quiz the student can open.
  await prisma.topicQuiz.create({ data: { topicId: w.topic.id, questions: [], kind: 'standard' } })
  assert.equal(await store.loadDraft(w.user.id, 'quiz', `${w.topic.id}:legacy`), null)
  assert.equal((await store.saveDraft(w.user.id, legacyInput(w, 0))).status, 'not_found')
})

dbTest('another user cannot write a legacy quiz draft into this topic', async () => {
  const w = await legacyWorld()
  const other = await world()
  const forged = await store.saveDraft(other.user.id, { ...legacyInput(w, 0), projectId: other.project.id })
  assert.equal(forged.status, 'not_found')
  assert.equal(await prisma.studyDraft.count({ where: { userId: other.user.id } }), 0)
})

dbTest('a user over the draft cap cannot start another, but can keep editing', async () => {
  const w = await world()
  const rows = Array.from({ length: store.MAX_DRAFTS_PER_USER }, (_, i) => ({
    userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, surface: 'recall', scopeKey: `${w.topic.id}:c${i}`,
    payload: { text: 'x', voice: false }, expiresAt: new Date(Date.now() + DAY),
  }))
  await prisma.studyDraft.createMany({ data: rows })
  assert.equal((await store.saveDraft(w.user.id, recallInput(w, 'one more', 0, `${w.topic.id}:extra`))).status, 'too_many')
  assert.equal((await store.saveDraft(w.user.id, recallInput(w, 'edit', 1, `${w.topic.id}:c0`))).status, 'saved')
})

dbTest('deleting the project or the account deletes its drafts', async () => {
  const w = await world()
  await store.saveDraft(w.user.id, recallInput(w, 'a', 0))
  await prisma.project.delete({ where: { id: w.project.id } })
  assert.equal(await prisma.studyDraft.count({ where: { userId: w.user.id } }), 0)
})
