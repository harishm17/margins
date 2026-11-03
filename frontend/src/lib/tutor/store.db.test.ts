/**
 * The TutorState row against a real, migrated Postgres (DATABASE_URL). Skipped when no database
 * with the tutor_states.bare_guesses column answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let store: typeof import('./store')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  store = await import('./store')
  available = await prisma.$queryRaw`SELECT bare_guesses FROM tutor_states LIMIT 1`.then(
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

async function makeUser() {
  const id = crypto.randomUUID()
  await prisma.user.create({ data: { id, email: `${id}@example.test`, name: 'Tutor test' } })
  userIds.push(id)
  return id
}

dbTest('a conversation with no row starts at rung 0', async () => {
  const userId = await makeUser()
  const state = await store.getTutorState(userId, 'ask', 'thread-1')
  assert.deepEqual(state, store.EMPTY_TUTOR_STATE)
})

dbTest('saved state round-trips, and rung 4 sets revealed for good', async () => {
  const userId = await makeUser()
  const saved = await store.saveTutorState(userId, 'practice', 'p1:2', {
    ...store.EMPTY_TUTOR_STATE,
    rung: 4,
    maxRung: 4,
    attempts: 3,
    hintsOpened: 3,
    bareGuesses: 1,
    sameRungNoProgress: 2,
    conceptIds: ['c1'],
  })
  assert.equal(saved.revealed, true)
  assert.deepEqual((await store.getTutorState(userId, 'practice', 'p1:2')).conceptIds, ['c1'])
  // a later write cannot lower the highest rung or clear revealed
  const lowered = await store.saveTutorState(userId, 'practice', 'p1:2', { ...store.EMPTY_TUTOR_STATE, rung: 1, attempts: 4 })
  assert.equal(lowered.maxRung, 4)
  assert.equal(lowered.revealed, true)
  assert.equal(lowered.hintsOpened, 3)
  assert.equal(lowered.rung, 1)
  assert.equal(await prisma.tutorState.count({ where: { userId } }), 1)
})

dbTest('scopes and keys are separate conversations', async () => {
  const userId = await makeUser()
  await store.saveTutorState(userId, 'ask', 'a', { ...store.EMPTY_TUTOR_STATE, rung: 2, maxRung: 2 })
  assert.equal((await store.getTutorState(userId, 'ask', 'b')).rung, 0)
  assert.equal((await store.getTutorState(userId, 'voice', 'a')).rung, 0)
  assert.equal((await store.getTutorState(userId, 'ask', 'a')).rung, 2)
})

dbTest('recordTutorEvent applies an event and saves counters and gap', async () => {
  const userId = await makeUser()
  const first = await store.recordTutorEvent(userId, 'practice', 's:1', { type: 'attempt', text: '42', correct: false }, { gapId: 'step-1' })
  assert.equal(first.state.rung, 1)
  assert.equal(first.state.bareGuesses, 1)
  assert.equal(first.state.gapId, 'step-1')
  const second = await store.recordTutorEvent(userId, 'practice', 's:1', { type: 'attempt', text: '17', correct: false }, { gapId: 'step-1' })
  assert.equal(second.state.bareGuesses, 2)
  assert.equal((await store.getTutorState(userId, 'practice', 's:1')).attempts, 2)
})

dbTest('concurrent first events create one row and apply both', async () => {
  const userId = await makeUser()
  const text = 'I think it is the second given'
  const results = await Promise.all([
    store.recordTutorEvent(userId, 'ask', 'race', { type: 'attempt', text }),
    store.recordTutorEvent(userId, 'ask', 'race', { type: 'attempt', text }),
  ])
  assert.equal(results.length, 2)
  assert.equal(await prisma.tutorState.count({ where: { userId, scopeKey: 'race' } }), 1)
  const state = await store.getTutorState(userId, 'ask', 'race')
  assert.equal(state.attempts, 2)
  assert.equal(state.rung, 2)
})

dbTest('concurrent first saves do not fail on the unique key', async () => {
  const userId = await makeUser()
  await Promise.all([
    store.saveTutorState(userId, 'voice', 'v', { ...store.EMPTY_TUTOR_STATE, rung: 1, maxRung: 1 }),
    store.saveTutorState(userId, 'voice', 'v', { ...store.EMPTY_TUTOR_STATE, rung: 1, maxRung: 1 }),
  ])
  assert.equal(await prisma.tutorState.count({ where: { userId, scopeKey: 'v' } }), 1)
})

dbTest('seeded concepts start a conversation and add to the ones it has, once each', async () => {
  const userId = await makeUser()
  await store.seedTutorConcepts(userId, 'ask', 'thread-seed', ['c1', 'c2'])
  assert.deepEqual((await store.getTutorState(userId, 'ask', 'thread-seed')).conceptIds, ['c1', 'c2'])
  await store.seedTutorConcepts(userId, 'ask', 'thread-seed', ['c2', 'c3'])
  const state = await store.getTutorState(userId, 'ask', 'thread-seed')
  assert.deepEqual(state.conceptIds, ['c1', 'c2', 'c3'])
  assert.equal(state.rung, 0)
  assert.equal(state.attempts, 0)
})

dbTest('help given and the help at the first wrong check are recorded, and only rise', async () => {
  const userId = await makeUser()
  const row = () => prisma.tutorState.findUniqueOrThrow({ where: { userId_scope_scopeKey: { userId, scope: 'practice', scopeKey: 'c:0:0' } } })
  await store.recordTutorEvent(userId, 'practice', 'c:0:0', { type: 'hint_opened', index: 0 })
  assert.equal((await row()).helpRung, 1)
  assert.equal((await row()).firstMissRung, null)
  // A wrong check does not count as help (it only raises the ladder), and names the help level so far.
  await store.recordTutorEvent(userId, 'practice', 'c:0:0', { type: 'attempt', text: 'x', correct: false })
  assert.equal((await row()).helpRung, 1)
  assert.equal((await row()).firstMissRung, 1)
  assert.ok((await row()).maxRung >= 1)
  // A reply's rung is help; a later wrong check leaves the first miss as it was; nothing lowers help.
  await store.recordTutorEvent(userId, 'practice', 'c:0:0', { type: 'attempt', text: 'a long enough explanation of the idea' }, { helpRung: 3 })
  await store.recordTutorEvent(userId, 'practice', 'c:0:0', { type: 'attempt', text: 'y', correct: false })
  await store.recordTutorEvent(userId, 'practice', 'c:0:0', { type: 'hint_opened', index: 0 })
  assert.equal((await row()).helpRung, 3)
  assert.equal((await row()).firstMissRung, 1)
})

dbTest('a conversation started over leaves nothing of the help, the first miss or the checked answer behind', async () => {
  const userId = await makeUser()
  const key = { userId_scope_scopeKey: { userId, scope: 'ask' as const, scopeKey: 'thread-reset' } }
  await store.recordTutorEvent(userId, 'ask', 'thread-reset', { type: 'attempt', text: 'x = 4', correct: false }, { helpRung: 3 })
  await store.recordTutorEvent(userId, 'ask', 'thread-reset', { type: 'attempt', text: 'x = 5', correct: true }, { conceptIds: ['c1'] })
  const before = await prisma.tutorState.findUniqueOrThrow({ where: key })
  assert.equal(before.helpRung, 3)
  assert.equal(before.firstMissRung, 0)
  assert.equal(before.checkedAnswer, 'x = 5')
  await store.resetTutorState(userId, 'ask', 'thread-reset')
  const after = await prisma.tutorState.findUniqueOrThrow({ where: key })
  assert.deepEqual([after.helpRung, after.firstMissRung, after.checkedAnswer, after.wrongChecks, after.checkedCorrect], [0, null, null, 0, false])
  // The concepts the conversation was about are kept.
  assert.deepEqual(after.conceptIds, ['c1'])
})

dbTest('an I do not know is recorded once with its time, and a started-over conversation forgets it', async () => {
  const userId = await makeUser()
  const key = { userId_scope_scopeKey: { userId, scope: 'practice' as const, scopeKey: 'c:0:1' } }
  assert.equal((await store.recordTutorEvent(userId, 'practice', 'c:0:1', { type: 'hint_opened', index: 0 })).state.checks, 0)
  assert.equal((await prisma.tutorState.findUniqueOrThrow({ where: key })).dontKnowAt, null)
  const first = await store.recordTutorEvent(userId, 'practice', 'c:0:1', { type: 'dont_know' })
  assert.deepEqual([first.state.checks, first.state.wrongChecks, first.state.attempts], [1, 1, 1])
  const stamped = (await prisma.tutorState.findUniqueOrThrow({ where: key })).dontKnowAt
  assert.notEqual(stamped, null)
  await store.recordTutorEvent(userId, 'practice', 'c:0:1', { type: 'dont_know' })
  assert.equal((await prisma.tutorState.findUniqueOrThrow({ where: key })).dontKnowAt?.getTime(), stamped?.getTime())
  await store.resetTutorState(userId, 'practice', 'c:0:1')
  assert.equal((await prisma.tutorState.findUniqueOrThrow({ where: key })).dontKnowAt, null)
})
