/**
 * Saving practice progress and the evidence it writes, against a real, migrated Postgres
 * (DATABASE_URL). Skipped when no database with the practice rung columns answers.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./practice-server')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./practice-server')
  available = await prisma.$queryRaw`SELECT max_rungs FROM practice_progress LIMIT 1`.then(
    () => true,
    () => false
  )
})

const dbTest = (name: string, run: () => Promise<void>) =>
  test(name, async (t) => {
    if (!available) return t.skip('no migrated test database')
    await run()
  })

const step = (n: number, extra: Record<string, unknown> = {}) => ({
  step_number: n,
  question: `Question ${n}`,
  hints: ['Look at the given.', 'The idea applies.', 'The general form.'],
  answer_type: 'text',
  correct_answer: `answer ${n}`,
  ...extra,
})

async function world(stepExtra: Record<string, unknown> = {}) {
  const user = await prisma.user.create({ data: { email: `ps-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const concept = await prisma.concept.create({
    data: { projectId: project.id, topicId: topic.id, name: 'C', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  await prisma.topicContent.create({
    data: {
      topicId: topic.id,
      contentType: 'interactive_examples',
      contentData: [{ title: 'P1', problem_statement: 'x', concept_ids: [concept.id], steps: [step(1, stepExtra), step(2, stepExtra), step(3, stepExtra)] }],
    },
  })
  return { user, project, topic, concept }
}

const base = { problemIndex: 0, problemTitle: 'P1', hintedSteps: [] as number[], timeZone: 'UTC' }
const save = (w: Awaited<ReturnType<typeof world>>, input: Record<string, unknown>) =>
  mod.savePracticeProgress(w.user.id, { id: w.topic.id, projectId: w.project.id }, { ...base, solvedSteps: [], revealedSteps: [], ...input })

/** What the server's own record of a step says (the tutor state the check and hint events write). */
async function seen(
  w: Awaited<ReturnType<typeof world>>,
  step: number,
  facts: Partial<{ checks: number; wrongChecks: number; checkedCorrect: boolean; hintsOpened: number; helpRung: number; maxRung: number; firstMissRung: number | null; dontKnowAt: Date | null }>
) {
  const content = await prisma.topicContent.findFirstOrThrow({ where: { topicId: w.topic.id, contentType: 'interactive_examples' } })
  const scopeKey = `${content.id}:0:${step}`
  await prisma.tutorState.upsert({
    where: { userId_scope_scopeKey: { userId: w.user.id, scope: 'practice', scopeKey } },
    create: { userId: w.user.id, scope: 'practice', scopeKey, ...facts },
    update: facts,
  })
}

const events = (w: Awaited<ReturnType<typeof world>>) =>
  prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'practice' }, orderBy: { createdAt: 'asc' } })

dbTest('a solved step on the first try writes level 0 score 1, once', async () => {
  const w = await world()
  const state = { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {} }
  await seen(w, 0, { checks: 1, checkedCorrect: true })
  assert.equal((await save(w, state)).status, 'saved')
  const first = await events(w)
  assert.equal(first.length, 1)
  assert.equal(first[0].score, 1)
  assert.equal(first[0].assistance, 0)
  assert.match(first[0].sessionKey, /^practice:[^:]+:\d{4}-\d{2}-\d{2}$/)
  // The same state sent again finishes nothing new.
  await save(w, state)
  assert.equal((await events(w)).length, 1)
})

dbTest('help of the connect rung after a miss records a failed first try with maxRung', async () => {
  const w = await world()
  await seen(w, 0, { checks: 2, wrongChecks: 1, checkedCorrect: true, hintsOpened: 2, helpRung: 3, firstMissRung: 3 })
  await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [], maxRungs: { '0': 3 }, hintedSteps: [0] })
  const rows = await events(w)
  assert.deepEqual(rows.map((row) => [row.assistance, row.score]), [[1, 0]])
  assert.ok(rows.every((row) => (row.metadata as { maxRung: number }).maxRung === 3))

  // Connect after a miss decides the step before it is finished.
  const open = await world()
  await seen(open, 0, { checks: 1, wrongChecks: 1, hintsOpened: 2, helpRung: 3, firstMissRung: 0 })
  await save(open, { attemptedSteps: [0], maxRungs: { '0': 3 }, hintedSteps: [0] })
  assert.deepEqual((await events(open)).map((row) => [row.assistance, row.score]), [[1, 0]])
})

dbTest('a shown answer after an attempt is a level-1 failure; before one it is refused', async () => {
  const w = await world()
  const refused = await save(w, { revealedSteps: [0], attemptedSteps: [], firstTrySteps: [], maxRungs: {} })
  assert.equal(refused.status, 'attempt_first')
  assert.equal((await events(w)).length, 0)
  assert.equal(await prisma.practiceProgress.count({ where: { userId: w.user.id } }), 0)

  await seen(w, 0, { checks: 1, wrongChecks: 1 })
  assert.equal((await save(w, { revealedSteps: [0], attemptedSteps: [0] })).status, 'saved')
  const rows = await events(w)
  assert.deepEqual(rows.map((row) => [row.assistance, row.score]), [[1, 0]])

  // Every hint opened does not allow the reveal either: it needs an attempt.
  const all = await world()
  assert.equal((await save(all, { revealedSteps: [0], maxRungs: { '0': 4 }, attemptedSteps: [], hintedSteps: [0] })).status, 'attempt_first')
  const old = await world({ hints: undefined, hint: 'Only hint' })
  assert.equal((await save(old, { revealedSteps: [0], maxRungs: { '0': 3 }, attemptedSteps: [], hintedSteps: [0] })).status, 'attempt_first')
  assert.equal((await events(all)).length + (await events(old)).length, 0)

  // Connect or a shown answer with no attempt is the gate, not a validation error.
  const gate = await world()
  assert.equal((await save(gate, { revealedSteps: [0], attemptedSteps: [], maxRungs: {} })).status, 'attempt_first')
  assert.equal((await save(gate, { attemptedSteps: [], maxRungs: { '1': 3 }, hintedSteps: [1] })).status, 'attempt_first')
  assert.equal((await save(gate, { attemptedSteps: [], maxRungs: { '1': 1 }, hintedSteps: [1] })).status, 'saved')
})

dbTest('rungs cannot go down and solved steps cannot un-solve, but Start over is accepted', async () => {
  const w = await world()
  await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: { '0': 3 }, hintedSteps: [0] })
  const down = await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: { '0': 1 }, hintedSteps: [0] })
  assert.equal(down.status, 'invalid')
  const unsolved = await save(w, { solvedSteps: [], attemptedSteps: [0], firstTrySteps: [0], maxRungs: { '0': 3 }, hintedSteps: [0] })
  assert.equal(unsolved.status, 'invalid')
  const reset = await save(w, { solvedSteps: [], attemptedSteps: [], firstTrySteps: [], maxRungs: {} })
  assert.equal(reset.status, 'saved')
  const row = await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.deepEqual(row.solvedSteps, [])
})

dbTest('the evidence level is the server\'s record, not what the browser says', async () => {
  const w = await world()
  // The browser says: first try, no help. The server saw a wrong check, then the right one, after two hints.
  await seen(w, 0, { checks: 2, wrongChecks: 1, checkedCorrect: true, hintsOpened: 2, helpRung: 3, firstMissRung: 3 })
  await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {}, missRungs: {} })
  const rows = await events(w)
  assert.deepEqual(rows.map((row) => [row.assistance, row.score]), [[1, 0]])
  assert.equal((rows[0].metadata as { maxRung: number }).maxRung, 3)
})

dbTest('evidence that fails to write keeps the progress and is written by the next save', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, checkedCorrect: true })
  const name = `ps_fail_${w.user.id.replace(/-/g, '')}`
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'evidence write refused'; END; $$ LANGUAGE plpgsql`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON evidence_events FOR EACH ROW WHEN (NEW.user_id = '${w.user.id}') EXECUTE FUNCTION ${name}()`)
  const state = { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {}, missRungs: {} }
  try {
    assert.equal((await save(w, state)).status, 'saved')
    assert.equal((await events(w)).length, 0)
    const row = await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })
    assert.deepEqual(row.solvedSteps, [0])
    assert.deepEqual(row.evidenceSteps, [])
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON evidence_events`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`)
  }
  await save(w, state)
  assert.equal((await events(w)).length, 1)
})

dbTest('two saves of one problem at once keep both steps and write each step\'s evidence once', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, checkedCorrect: true })
  await seen(w, 1, { checks: 1, checkedCorrect: true })
  const one = { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {}, missRungs: {} }
  const both = { solvedSteps: [0, 1], attemptedSteps: [0, 1], firstTrySteps: [0, 1], maxRungs: {}, missRungs: {} }
  const results = await Promise.all([save(w, one), save(w, both), save(w, one), save(w, both)])
  // A smaller state arriving after a larger one is refused (a solved step cannot un-solve), never half-applied.
  assert.ok(results.every((result) => result.status === 'saved' || result.status === 'invalid'))
  assert.ok(results.some((result) => result.status === 'saved'))
  const rows = await events(w)
  assert.deepEqual(rows.map((row) => row.itemKey).sort(), [...new Set(rows.map((row) => row.itemKey))].sort())
  assert.equal(rows.length, 2)
  const row = await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.deepEqual(row.evidenceSteps.slice().sort(), [0, 1])
})
