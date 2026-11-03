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
})

dbTest('every hint opened no longer allows the reveal: it needs an attempt', async () => {
  const all = await world()
  assert.equal((await save(all, { revealedSteps: [0], maxRungs: { '0': 4 }, attemptedSteps: [], hintedSteps: [0] })).status, 'attempt_first')
  const old = await world({ hints: undefined, hint: 'Only hint' })
  assert.equal((await save(old, { revealedSteps: [0], maxRungs: { '0': 3 }, attemptedSteps: [], hintedSteps: [0] })).status, 'attempt_first')
  assert.equal((await events(all)).length + (await events(old)).length, 0)
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

dbTest('a save of a step checked wrong and not yet solved keeps the server\'s record of the checks; only Start over clears it', async () => {
  const w = await world()
  const content = await prisma.topicContent.findFirstOrThrow({ where: { topicId: w.topic.id, contentType: 'interactive_examples' } })
  const key = { userId_scope_scopeKey: { userId: w.user.id, scope: 'practice' as const, scopeKey: `${content.id}:0:0` } }
  await seen(w, 0, { checks: 2, wrongChecks: 2 })
  // The browser reports the attempt (nothing solved, shown or hinted yet): that is progress, not a new run.
  const attempted = await save(w, { attemptedSteps: [0], firstTrySteps: [], maxRungs: { '0': 1 }, missRungs: { '0': 0 } })
  assert.equal(attempted.status, 'saved')
  const kept = await prisma.tutorState.findUniqueOrThrow({ where: key })
  assert.deepEqual([kept.checks, kept.wrongChecks], [2, 2])
  // Start over sends nothing at all, and the ladder and its record start again.
  assert.equal((await save(w, { attemptedSteps: [], firstTrySteps: [], maxRungs: {}, missRungs: {} })).status, 'saved')
  assert.equal(await prisma.tutorState.findUnique({ where: key }), null)
})

dbTest('a browser from before rungs still saves, writes no evidence and keeps stored rungs', async () => {
  const w = await world()
  await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: { '0': 1 }, hintedSteps: [0] })
  const before = (await events(w)).length
  const result = await save(w, { solvedSteps: [0, 1], hintedSteps: [0] })
  assert.equal(result.status, 'saved')
  assert.equal((await events(w)).length, before)
  const row = await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.deepEqual(row.solvedSteps, [0, 1])
  assert.deepEqual(row.maxRungs, { '0': 1 })
})

dbTest('a first upload of local progress writes no evidence', async () => {
  const w = await world()
  await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {}, migrated: true })
  assert.equal((await events(w)).length, 0)
})

dbTest('a step with no concepts writes no evidence, and the practice signal still comes at the end', async () => {
  const w = await world()
  await prisma.topicContent.update({
    where: { topicId_contentType: { topicId: w.topic.id, contentType: 'interactive_examples' } },
    data: { contentData: [{ title: 'P1', problem_statement: 'x', steps: [step(1)] }] },
  })
  await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {} })
  assert.equal((await events(w)).length, 0)
  assert.deepEqual((await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })).evidenceSteps, [0])
  assert.equal(await prisma.learningSignal.count({ where: { userId: w.user.id, source: 'practice' } }), 1)
})

dbTest('a first upload of local progress is checked too: a shown answer with no attempt is refused', async () => {
  const w = await world()
  const refused = await save(w, { revealedSteps: [0], attemptedSteps: [], firstTrySteps: [], maxRungs: {}, missRungs: {}, migrated: true })
  assert.equal(refused.status, 'attempt_first')
  assert.equal(await prisma.practiceProgress.count({ where: { userId: w.user.id } }), 0)
  // What parseProgress gives local progress from before rungs (finished steps count as attempted) is accepted.
  const ok = await save(w, { revealedSteps: [0], solvedSteps: [1], attemptedSteps: [0, 1], firstTrySteps: [], maxRungs: {}, missRungs: {}, migrated: true })
  assert.equal(ok.status, 'saved')
  assert.equal((await events(w)).length, 0)
})

dbTest('a hinted step with no stored rung counts as at least rung 1', async () => {
  const w = await world()
  // Hinted, first-try right, no rung sent: the locate cap (0.6) applies, not a clean 1.
  await seen(w, 0, { checks: 1, checkedCorrect: true, hintsOpened: 1 })
  await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {}, missRungs: {}, hintedSteps: [0] })
  const rows = await events(w)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].score, 0.6)
  assert.equal(rows[0].assistance, 0)
  const row = await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.deepEqual(row.maxRungs, { '0': 1 })
})

dbTest('a locate hint after the first wrong check scores the same as one before it; Connect is the failure', async () => {
  const after = await world()
  await save(after, { attemptedSteps: [0], firstTrySteps: [], maxRungs: {}, missRungs: { '0': 0 } })
  await seen(after, 0, { checks: 2, wrongChecks: 1, checkedCorrect: true, hintsOpened: 1, helpRung: 1, firstMissRung: 0 })
  await save(after, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [], maxRungs: { '0': 1 }, missRungs: { '0': 0 }, hintedSteps: [0] })
  assert.deepEqual((await events(after)).map((row) => [row.assistance, row.score]), [[0, 0.6]])

  const before = await world()
  await save(before, { attemptedSteps: [0], firstTrySteps: [], maxRungs: { '0': 3 }, missRungs: { '0': 3 }, hintedSteps: [0] })
  await seen(before, 0, { checks: 2, wrongChecks: 1, checkedCorrect: true, hintsOpened: 2, helpRung: 3, firstMissRung: 3 })
  await save(before, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [], maxRungs: { '0': 3 }, missRungs: { '0': 3 }, hintedSteps: [0] })
  assert.deepEqual((await events(before)).map((row) => [row.assistance, row.score]), [[1, 0]])
})

dbTest('start over and solving again the same day is one review, not two', async () => {
  const w = await world()
  const solved = { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {}, missRungs: {} }
  const reset = { solvedSteps: [], attemptedSteps: [], firstTrySteps: [], maxRungs: {}, missRungs: {} }
  await seen(w, 0, { checks: 1, checkedCorrect: true })
  await save(w, solved)
  const memory = () => prisma.conceptMemory.findFirstOrThrow({ where: { userId: w.user.id, conceptId: w.concept.id } })
  const once = await memory()
  await save(w, reset)
  // Starting over starts the ladder over too: the step's record is gone until it is checked again.
  assert.equal(await prisma.tutorState.count({ where: { userId: w.user.id, scope: 'practice' } }), 0)
  await seen(w, 0, { checks: 1, checkedCorrect: true })
  await save(w, solved)
  const rows = await events(w)
  // Two events share one item key and one session key, and replay turns the group into a single review.
  assert.equal(rows.length, 2)
  assert.equal(new Set(rows.map((row) => row.itemKey)).size, 1)
  assert.equal(new Set(rows.map((row) => row.sessionKey)).size, 1)
  const twice = await memory()
  assert.equal(twice.nUnassisted, once.nUnassisted)
  assert.equal((twice.card as { reps: number }).reps, (once.card as { reps: number }).reps)
})

dbTest('a finished problem from a browser without rung fields is stored but earns no signal or review', async () => {
  const w = await world()
  const result = await save(w, { solvedSteps: [0, 1, 2], hintedSteps: [] })
  assert.equal(result.status, 'saved')
  assert.equal(result.status === 'saved' && result.completed, true)
  const row = await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.deepEqual(row.solvedSteps, [0, 1, 2])
  assert.equal(await prisma.learningSignal.count({ where: { userId: w.user.id, source: 'practice' } }), 0)
  assert.equal(await prisma.reviewSchedule.count({ where: { userId: w.user.id } }), 0)
  assert.equal((await events(w)).length, 0)
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

dbTest('a solved step the server never saw checked writes nothing until it is, and then once', async () => {
  const w = await world()
  const claimed = { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: {}, missRungs: {} }
  assert.equal((await save(w, claimed)).status, 'saved')
  assert.equal((await events(w)).length, 0)
  const row = await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.deepEqual(row.solvedSteps, [0])
  assert.deepEqual(row.evidenceSteps, [])

  await seen(w, 0, { checks: 1, checkedCorrect: true })
  await save(w, claimed)
  await save(w, claimed)
  assert.equal((await events(w)).length, 1)
  assert.deepEqual((await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })).evidenceSteps, [0])
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

dbTest('finishing a practice on a converted topic leaves the concepts\' review date alone', async () => {
  const w = await world()
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  for (const step of [0, 1, 2]) await seen(w, step, { checks: 1, checkedCorrect: true })
  const all = { solvedSteps: [0, 1, 2], attemptedSteps: [0, 1, 2], firstTrySteps: [0, 1, 2], maxRungs: {}, missRungs: {} }
  const result = await save(w, all)
  assert.equal(result.status === 'saved' && result.completedNow, true)
  const memory = await prisma.conceptMemory.findFirstOrThrow({ where: { userId: w.user.id, conceptId: w.concept.id } })
  const schedule = await prisma.reviewSchedule.findFirstOrThrow({ where: { userId: w.user.id, topicId: w.topic.id } })
  assert.equal(schedule.dueAt.getTime(), memory.dueAt!.getTime())
  assert.ok(Math.abs(schedule.mastery - memory.mastery) < 1e-2)
})

/** Moves the step's tutor-state row back in time: the day the student last touched it. */
async function backdate(w: Awaited<ReturnType<typeof world>>, days: number) {
  const at = new Date(Date.now() - days * 86_400_000)
  await prisma.tutorState.updateMany({ where: { userId: w.user.id }, data: { updatedAt: at } })
  return at
}

const day = (at: Date) => at.toISOString().slice(0, 10)

dbTest('miss then locate then right writes level 0 at 0.6', async () => {
  const w = await world()
  await seen(w, 0, { checks: 2, wrongChecks: 1, checkedCorrect: true, hintsOpened: 1, helpRung: 1, firstMissRung: 0 })
  await save(w, { solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [], maxRungs: { '0': 1 }, missRungs: { '0': 0 }, hintedSteps: [0] })
  assert.deepEqual((await events(w)).map((row) => [row.assistance, row.score]), [[0, 0.6]])
})

dbTest('dont know writes level 1 at once, flagged, and the later solve adds no second record', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, wrongChecks: 1, dontKnowAt: new Date() })
  assert.equal((await save(w, { attemptedSteps: [0], maxRungs: {} })).status, 'saved')
  const rows = await events(w)
  assert.deepEqual(rows.map((row) => [row.assistance, row.score]), [[1, 0]])
  assert.deepEqual(rows[0].metadata, { maxRung: 0, idk: true, missKind: 'cue_miss' })
  assert.deepEqual((await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })).evidenceSteps, [0])
  // The step is solved later, after help: the first try is already recorded.
  await seen(w, 0, { checks: 2, wrongChecks: 1, checkedCorrect: true, hintsOpened: 2, helpRung: 3 })
  await save(w, { solvedSteps: [0], attemptedSteps: [0], maxRungs: { '0': 3 }, hintedSteps: [0] })
  assert.equal((await events(w)).length, 1)
})

dbTest('Connect after a miss decides the step before it is finished', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, wrongChecks: 1, hintsOpened: 2, helpRung: 3, firstMissRung: 0 })
  await save(w, { attemptedSteps: [0], maxRungs: { '0': 3 }, hintedSteps: [0] })
  assert.deepEqual((await events(w)).map((row) => [row.assistance, row.score]), [[1, 0]])
})

dbTest('one wrong check with at most the locate hint stays open: nothing is written yet', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, wrongChecks: 1, hintsOpened: 1, helpRung: 1, firstMissRung: 0 })
  await save(w, { attemptedSteps: [0], maxRungs: { '0': 1 }, hintedSteps: [0] })
  assert.equal((await events(w)).length, 0)
  assert.deepEqual((await prisma.practiceProgress.findFirstOrThrow({ where: { userId: w.user.id } })).evidenceSteps, [])
})

dbTest('open miss settles as level 1 next day', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, wrongChecks: 1 })
  await save(w, { attemptedSteps: [0], maxRungs: {} })
  assert.equal((await events(w)).length, 0)
  const missedOn = await backdate(w, 2)
  const result = await mod.settleOpenMisses(w.user.id, w.topic.id, 'UTC')
  assert.equal(result.settled, 1)
  const rows = await events(w)
  assert.deepEqual(rows.map((row) => [row.assistance, row.score]), [[1, 0]])
  // The session is the local day of the step's first check.
  assert.equal(rows[0].sessionKey.endsWith(day(missedOn)), true, `${rows[0].sessionKey} ${day(missedOn)}`)
})

dbTest('open miss not settled the same day', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, wrongChecks: 1 })
  await save(w, { attemptedSteps: [0], maxRungs: {} })
  assert.equal((await mod.settleOpenMisses(w.user.id, w.topic.id, 'UTC')).settled, 0)
  assert.equal((await events(w)).length, 0)
})

dbTest('settle is idempotent, and a later save does not write the step again', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, wrongChecks: 1 })
  await save(w, { attemptedSteps: [0], maxRungs: {} })
  await backdate(w, 1)
  assert.equal((await mod.settleOpenMisses(w.user.id, w.topic.id, 'UTC')).settled, 1)
  assert.equal((await mod.settleOpenMisses(w.user.id, w.topic.id, 'UTC')).settled, 0)
  await Promise.all([mod.settleOpenMisses(w.user.id, w.topic.id, 'UTC'), mod.settleOpenMisses(w.user.id, w.topic.id, 'UTC')])
  await seen(w, 0, { checks: 2, wrongChecks: 1, checkedCorrect: true })
  await save(w, { solvedSteps: [0], attemptedSteps: [0], maxRungs: {} })
  assert.equal((await events(w)).length, 1)
})

dbTest('loading the progress settles the open misses of an earlier day', async () => {
  const w = await world()
  await seen(w, 0, { checks: 1, wrongChecks: 1 })
  await save(w, { attemptedSteps: [0], maxRungs: {} })
  await backdate(w, 3)
  await mod.loadPracticeProgress(w.user.id, w.topic.id, 'UTC')
  assert.equal((await events(w)).length, 1)
})

dbTest('Connect or a shown answer with no attempt is the gate, not a validation error', async () => {
  const w = await world()
  assert.equal((await save(w, { revealedSteps: [0], attemptedSteps: [], maxRungs: {} })).status, 'attempt_first')
  assert.equal((await save(w, { attemptedSteps: [], maxRungs: { '1': 3 }, hintedSteps: [1] })).status, 'attempt_first')
  assert.equal((await save(w, { attemptedSteps: [], maxRungs: { '1': 1 }, hintedSteps: [1] })).status, 'saved')
})
