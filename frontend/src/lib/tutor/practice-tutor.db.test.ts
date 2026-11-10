/**
 * "Ask about my working" against a real, migrated Postgres (DATABASE_URL), with a fake AI service.
 * Skipped when no database with the tutor_states.bare_guesses column answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { PracticeTutorRequest } from '@/lib/ai-service/tutor'
import { TutorUnavailableError } from '@/lib/ai-service/tutor'

let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./practice-tutor')
let context: typeof import('./practice-context')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./practice-tutor')
  context = await import('./practice-context')
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

const numeric = (n: number, answer: string, extra: Record<string, unknown> = {}) => ({
  step_number: n,
  question: `What is step ${n}?`,
  hints: [`Look at ${n}.`, `The idea of ${n}.`, `The form of ${n}.`],
  answer_type: 'numeric',
  correct_answer: answer,
  ...extra,
})

async function world() {
  const user = await prisma.user.create({ data: { email: `pt-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const concept = await prisma.concept.create({
    data: { projectId: project.id, topicId: topic.id, name: 'Rates', summary: 'A rate compares two quantities.', kind: 'concept', orderIndex: 0 },
  })
  await prisma.topicContent.create({
    data: {
      topicId: topic.id,
      contentType: 'interactive_examples',
      contentData: [
        { title: 'P1', problem_statement: 'Work out three values.', concept_ids: [concept.id], steps: [numeric(1, '12'), numeric(2, '30'), numeric(3, '7.5')] },
      ],
    },
  })
  return { user, project, topic, concept }
}

type World = Awaited<ReturnType<typeof world>>
const reply = { reply: 'What did you try first?', rung_used: 0, mistake: { located: true, where: 'step 2', kind: 'execution' as const }, reveals_answer: false, leaked: false, from_authored_hint: false }

function fakes(answer: typeof reply | Error = reply) {
  const calls: PracticeTutorRequest[] = []
  return {
    calls,
    deps: {
      ask: async (request: PracticeTutorRequest) => {
        calls.push(request)
        if (answer instanceof Error) throw answer
        return answer
      },
      context: context.loadPracticeContext,
    },
  }
}

const base = { problemIndex: 0, problemTitle: 'P1', stepIndex: 1 }
const run = (w: World, body: Record<string, unknown>, deps = fakes().deps) =>
  mod.runPracticeTutor(w.user.id, { id: w.topic.id, projectId: w.project.id }, { ...base, ...body } as never, { timeZone: 'UTC' }, deps)
const stateOf = async (w: World) => (await prisma.tutorState.findFirst({ where: { userId: w.user.id } }))!

dbTest('a checked answer is one event; a wrong one unlocks the worked example and counts as an attempt', async () => {
  const w = await world()
  const wrong = await run(w, { event: 'check', answer: '25' })
  assert.equal(wrong.status, 'ok')
  if (wrong.status !== 'ok') return
  assert.equal(wrong.body.correct, false)
  assert.equal(wrong.body.state.attempts, 1)
  assert.equal(wrong.body.state.workedAllowed, true)
  assert.equal(wrong.body.state.rung, 1)
  // The key is the content, problem and step (spec 6.2).
  const row = await stateOf(w)
  assert.match(row.scopeKey, /^[^:]+:0:1$/)
  assert.equal(row.scope, 'practice')
  // A right answer is not a failure: the attempt count and the rung stay.
  const right = await run(w, { event: 'check', answer: '30' })
  assert.equal(right.status === 'ok' && right.body.correct, true)
  assert.equal(right.status === 'ok' && right.body.state.attempts, 1)
})

dbTest('worked example button is refused before an attempt and leaves the state as it was', async () => {
  const w = await world()
  const f = fakes()
  const refused = await run(w, { event: 'show_worked' }, f.deps)
  assert.equal(refused.status, 'attempt_first')
  assert.equal(f.calls.length, 0)
  assert.equal(await prisma.tutorState.count({ where: { userId: w.user.id } }), 0)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)
})

dbTest('ask sends the move, the rung, the located step, the hints shown and no final unless the answer was given', async () => {
  const w = await world()
  const f = fakes()
  await run(w, { event: 'hint', hintIndex: 0 }, f.deps)
  await run(w, { event: 'check', answer: '25' }, f.deps)
  const result = await run(w, { event: 'ask', working: 'I had 12, then 12 * 3 = 36, so 36 / 4.8 = 7.5', attempts: ['25'] }, f.deps)
  assert.equal(result.status, 'ok')
  assert.equal(f.calls.length, 1)
  const request = f.calls[0]
  assert.equal(request.step_index, 1)
  assert.equal(request.first_wrong_step, 1)
  assert.deepEqual(request.hints_shown, ['Look at 2.'])
  assert.deepEqual(request.attempts, ['25'])
  assert.equal(request.final_allowed, false)
  assert.equal(request.move, 'ladder')
  // The hint (rung 1), the wrong check (2) and the working with reasoning (3) each climb one.
  assert.equal(request.rung_allowed, 3)
  assert.equal(request.steps.length, 3)
  assert.deepEqual(request.steps[1].hints, ['Look at 2.', 'The idea of 2.', 'The form of 2.'])
  assert.equal(request.steps[1].answer, '30')
  assert.equal(request.user_id, w.user.id)
  if (result.status !== 'ok') return
  assert.equal(result.body.reply?.text, 'What did you try first?')
  assert.equal(result.body.reply?.missKind, 'execution')
  // The state was saved: the wrong check and the working are two attempts.
  assert.equal((await stateOf(w)).attempts, 2)
})

dbTest('final_allowed only when the student already gave the correct answer', async () => {
  const w = await world()
  const f = fakes()
  await run(w, { event: 'check', answer: '25' }, f.deps)
  await run(w, { event: 'ask', working: 'I think the answer is 30 because of the ratio', attempts: ['25'] }, f.deps)
  assert.equal(f.calls[0].final_allowed, false)
  // The server saw the right answer; the browser's list is not what decides.
  await run(w, { event: 'check', answer: '30' }, f.deps)
  await run(w, { event: 'ask', working: 'It is 30 because of the ratio', attempts: [] }, f.deps)
  assert.equal(f.calls[1].final_allowed, true)
  // The answer a reply may confirm is the one the server graded and stored, whatever the browser lists or writes.
  assert.equal(f.calls[1].own_answer, '30')
  await run(w, { event: 'ask', working: 'Again, thirty. Maybe 31?', attempts: ['30', '31'] }, f.deps)
  assert.equal(f.calls[2].own_answer, '30')
  assert.deepEqual(f.calls[2].attempts, ['30', '31'])
})

dbTest('the answer a reply may confirm never comes from the browser: forged attempts and working give none', async () => {
  const w = await world()
  const f = fakes()
  // Nothing was checked, so nothing is allowed, however the browser words its attempts and working.
  await run(w, { event: 'check', answer: '25' }, f.deps)
  await run(w, { event: 'ask', working: 'The answer is 30', attempts: ['30', '30'] }, f.deps)
  assert.equal(f.calls[0].final_allowed, false)
  assert.equal(f.calls[0].own_answer, undefined)
  // A worked example confirms nothing, even after a right check.
  await run(w, { event: 'check', answer: '30' }, f.deps)
  await run(w, { event: 'show_worked' }, f.deps)
  assert.equal(f.calls[1].final_allowed, false)
  assert.equal(f.calls[1].own_answer, undefined)
})

dbTest('a model call that fails leaves the state as it was, and a retry is the same event', async () => {
  const w = await world()
  const down = fakes(new TutorUnavailableError('LLM_UNAVAILABLE', 503))
  await run(w, { event: 'check', answer: '25' }, down.deps)
  const before = await stateOf(w)
  await assert.rejects(run(w, { event: 'ask', working: 'I am not sure about the ratio here', attempts: ['25'] }, down.deps), TutorUnavailableError)
  const after = await stateOf(w)
  assert.equal(after.attempts, before.attempts)
  assert.equal(after.rung, before.rung)
  const retry = await run(w, { event: 'ask', working: 'I am not sure about the ratio here', attempts: ['25'] })
  assert.equal(retry.status, 'ok')
  assert.equal((await stateOf(w)).attempts, before.attempts + 1)
})

dbTest('the worked example surrenders the step once: level 3, flagged, rung 5', async () => {
  const w = await world()
  const f = fakes()
  await run(w, { event: 'check', answer: '25' }, f.deps)
  const first = await run(w, { event: 'show_worked', attempts: ['25'] }, f.deps)
  assert.equal(first.status === 'ok' && first.body.surrendered, true)
  assert.equal(f.calls[0].move, 'worked_analogue')
  assert.equal(f.calls[0].rung_allowed, 5)
  assert.equal(f.calls[0].final_allowed, false)
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.equal(events.length, 1)
  assert.equal(events[0].assistance, 3)
  assert.equal(events[0].source, 'practice')
  assert.match(events[0].itemKey, /^practice:[^:]+:0:1$/)
  assert.deepEqual(events[0].metadata, { maxRung: 5, surrendered: true, contentId: events[0].itemKey.split(':')[1], problemIndex: 0, step: 1 })
  const row = await stateOf(w)
  assert.equal(row.rung, 5)
  assert.equal(row.revealed, true)
  // Shown again: no second record.
  await run(w, { event: 'show_worked', attempts: ['25'] }, f.deps)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 1)
})

dbTest('a rewritten practice is stale', async () => {
  const w = await world()
  const stale = await run(w, { event: 'check', answer: '1', problemTitle: 'Another title' })
  assert.equal(stale.status, 'stale')
})

dbTest('the graph adds claims, a weak prerequisite and the confusable concept', async () => {
  const w = await world()
  const mk = (name: string) => prisma.concept.create({ data: { projectId: w.project.id, topicId: w.topic.id, name, summary: `${name} summary`, kind: 'concept', orderIndex: 5 } })
  const [prereq, other] = [await mk('Ratios'), await mk('Proportions')]
  const material = await prisma.material.create({ data: { projectId: w.project.id, category: 'lecture_notes', filename: 'm.pdf', gcsPath: 'x', sizeBytes: 1 } })
  await prisma.conceptClaim.create({ data: { conceptId: w.concept.id, text: 'A rate divides.', quote: 'rate = a / b', materialId: material.id, pageStart: 4, orderIndex: 0 } })
  await prisma.conceptClaim.create({ data: { conceptId: prereq.id, text: 'A ratio compares.', quote: 'ratio a:b', materialId: material.id, pageStart: 2, orderIndex: 0 } })
  await prisma.conceptEdge.create({ data: { projectId: w.project.id, sourceId: prereq.id, targetId: w.concept.id, type: 'prerequisite', weight: 1, confidence: 0.9, status: 'confirmed' } })
  const [a, b] = [w.concept.id, other.id].sort()
  await prisma.conceptEdge.create({ data: { projectId: w.project.id, sourceId: a, targetId: b, type: 'confusable', weight: 1, confidence: 0.9, status: 'confirmed' } })
  // The prerequisite was learned long ago, so little of it is left.
  await prisma.conceptMemory.create({
    data: {
      userId: w.user.id,
      projectId: w.project.id,
      topicId: w.topic.id,
      conceptId: prereq.id,
      card: { due: new Date(Date.now() - 86_400_000).toISOString(), stability: 1, difficulty: 5, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 2, last_review: new Date(Date.now() - 60 * 86_400_000).toISOString() },
      lastEvidenceAt: new Date(Date.now() - 60 * 86_400_000),
    },
  })
  const loaded = await context.loadPracticeContext(w.user.id, w.project.id, [w.concept.id])
  assert.deepEqual(loaded.claims, [{ text: 'A rate divides.', quote: 'rate = a / b', page: 4 }])
  assert.deepEqual(loaded.weakPrerequisite, { name: 'Ratios', page: 2 })
  assert.deepEqual(loaded.confusable, { name: 'Proportions', summary: 'Proportions summary' })
  assert.deepEqual(await context.loadPracticeContext(w.user.id, w.project.id, []), { claims: [] })
})

test('the weakest prerequisite below the line wins; unmeasured ones are skipped', async () => {
  const pick = (await import('./practice-context')).pickWeakPrerequisite
  assert.equal(pick([{ retrievability: 0.9 }, { retrievability: null }]), null)
  assert.deepEqual(pick([{ retrievability: 0.7 }, { retrievability: 0.3 }, { retrievability: null }]), { retrievability: 0.3 })
})

dbTest('only the latest message is the event: a short reply after long working is not an attempt', async () => {
  const w = await world()
  const f = fakes()
  await run(w, { event: 'check', answer: '25' }, f.deps)
  await run(w, { event: 'ask', working: 'I tried 12 times 3 and got 36, which is too big.', message: 'I tried 12 times 3 and got 36, which is too big.' }, f.deps)
  assert.equal((await stateOf(w)).attempts, 2)
  await run(w, { event: 'ask', working: 'I tried 12 times 3 and got 36, which is too big.\nok', message: 'ok' }, f.deps)
  const row = await stateOf(w)
  assert.deepEqual([row.attempts, row.lowEffortTurns], [2, 1])
  // The tutor still read everything that was written.
  assert.match(f.calls[1].working, /36, which is too big\.\nok$/)
  // Accepting the offer sends an empty message: a request, not an attempt, even with working on the page.
  await run(w, { event: 'ask', working: 'I tried 12 times 3 and got 36, which is too big.', message: '' }, f.deps)
  assert.deepEqual([(await stateOf(w)).attempts, (await stateOf(w)).lowEffortTurns], [2, 2])
})

dbTest('the server keeps the check counts, so a reload loses nothing', async () => {
  const w = await world()
  await run(w, { event: 'check', answer: '1' })
  await run(w, { event: 'check', answer: '2' })
  const read = await mod.readPracticeTutorState(w.user.id, w.topic, { problemIndex: 0, problemTitle: 'P1', stepIndex: 1 })
  assert.deepEqual([read?.checks, read?.wrongChecks, read?.checkedCorrect, read?.workedAllowed], [2, 2, false, true])
  await run(w, { event: 'check', answer: '30' })
  assert.equal((await mod.readPracticeTutorState(w.user.id, w.topic, { problemIndex: 0, problemTitle: 'P1', stepIndex: 1 }))?.checkedCorrect, true)
  assert.equal(await mod.readPracticeTutorState(w.user.id, w.topic, { problemIndex: 0, problemTitle: 'Other', stepIndex: 1 }), null)
})

dbTest('lastWrong and the confirm move come from the server record of the checks', async () => {
  const w = await world()
  const f = fakes()
  await run(w, { event: 'check', answer: '25' }, f.deps)
  await run(w, { event: 'ask', working: 'I tried 5 times 5 and that gave 25', missKind: 'misconception', attempts: [] }, f.deps)
  // The last check was wrong, so the move is confront, though the browser sent no attempts.
  assert.equal(f.calls[0].move, 'confront')
  await run(w, { event: 'hint', hintIndex: 1 }, f.deps)
  await run(w, { event: 'check', answer: '30' }, f.deps)
  // "Check my understanding": a request with no text on a step solved with help.
  await run(w, { event: 'ask', working: '', message: '' }, f.deps)
  assert.equal(f.calls[1].move, 'confirm')
  assert.equal(f.calls[1].final_allowed, true)
  // Their answer to it is a reply to discuss, not another transfer question.
  await run(w, { event: 'ask', working: 'It would still work with other numbers', message: 'It would still work with other numbers' }, f.deps)
  assert.notEqual(f.calls[2].move, 'confirm')
  // Solved without help: no confirm.
  const other = await world()
  const g = fakes()
  await run(other, { event: 'check', answer: '30' }, g.deps)
  await run(other, { event: 'ask', working: '', message: '' }, g.deps)
  assert.notEqual(g.calls[0].move, 'confirm')
})

dbTest('requests that are invalid or stale do not use the model budget', async () => {
  const w = await world()
  let admitted = 0
  const admit = () => {
    admitted += 1
    return { ok: true } as const
  }
  const call = (body: Record<string, unknown>) =>
    mod.runPracticeTutor(w.user.id, { id: w.topic.id, projectId: w.project.id }, { ...base, ...body } as never, { timeZone: 'UTC', admit }, fakes().deps)
  assert.equal((await call({ event: 'clarify', problemTitle: 'Other' })).status, 'stale')
  assert.equal((await call({ event: 'show_worked' })).status, 'attempt_first')
  assert.equal((await call({ event: 'ask', working: 'some reasoning about the ratio here' })).status, 'not_allowed')
  assert.equal(admitted, 0)
  assert.equal((await call({ event: 'clarify' })).status, 'ok')
  assert.equal(admitted, 1)
  // When the limit says wait, the model is not called and the state does not change.
  const limited = await mod.runPracticeTutor(
    w.user.id,
    { id: w.topic.id, projectId: w.project.id },
    { ...base, event: 'clarify' } as never,
    { timeZone: 'UTC', admit: () => ({ ok: false, retryAfterSeconds: 7 }) },
    fakes().deps
  )
  assert.deepEqual(limited, { status: 'rate_limited', retryAfterSeconds: 7 })
})

dbTest('a check with nothing written earns no rung and does not unlock "Ask about my working"', async () => {
  const w = await world()
  const f = fakes()
  const empty = await run(w, { event: 'check', answer: '   ' }, f.deps)
  assert.ok(empty.status === 'ok' && empty.body.correct === false)
  assert.deepEqual([empty.body.state.rung, empty.body.state.checks, empty.body.state.attempts], [0, 0, 0])
  assert.equal(await prisma.tutorState.count({ where: { userId: w.user.id } }), 0, 'nothing was stored')
  assert.equal((await run(w, { event: 'ask', working: 'I tried multiplying the first two numbers together' }, f.deps)).status, 'not_allowed')
  assert.equal(f.calls.length, 0)
})

/** Gives every step of the world's problem the concept, so the evidence of the help is written. */
async function withConceptSteps(w: World) {
  const content = await prisma.topicContent.findFirstOrThrow({ where: { topicId: w.topic.id } })
  const data = content.contentData as { steps: Record<string, unknown>[] }[]
  data[0].steps.forEach((s) => (s.concept_ids = [w.concept.id]))
  await prisma.topicContent.update({ where: { id: content.id }, data: { contentData: data as never } })
}

const surrenders = (w: World) => prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'practice', assistance: 3 } })

dbTest('connect before a check is refused with ATTEMPT_FIRST and leaves the state as it was', async () => {
  const w = await world()
  const connect = await run(w, { event: 'hint', hintIndex: 1 })
  const structure = await run(w, { event: 'hint', hintIndex: 2 })
  const reveal = await run(w, { event: 'reveal' })
  assert.deepEqual([connect.status, structure.status, reveal.status], ['attempt_first', 'attempt_first', 'attempt_first'])
  assert.equal(await prisma.tutorState.count({ where: { userId: w.user.id } }), 0)
  // Locate is open from the start; Connect opens after one check, and after the IDK button too.
  assert.equal((await run(w, { event: 'hint', hintIndex: 0 })).status, 'ok')
  assert.equal((await run(w, { event: 'check', answer: '25' })).status, 'ok')
  assert.equal((await run(w, { event: 'hint', hintIndex: 1 })).status, 'ok')
  const other = await world()
  assert.equal((await run(other, { event: 'dont_know' })).status, 'ok')
  assert.equal((await run(other, { event: 'hint', hintIndex: 1 })).status, 'ok')
})

dbTest('fallback worked example is not surrendered', async () => {
  const w = await world()
  await withConceptSteps(w)
  await run(w, { event: 'check', answer: '25' })
  // The leak judge fell back to the authored structure hint.
  const fallback = fakes({ ...reply, reply: 'The form of 2.', rung_used: 4, from_authored_hint: true })
  const result = await run(w, { event: 'show_worked', attempts: ['25'] }, fallback.deps)
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.body.surrendered, undefined)
  assert.equal(result.body.reply?.rungUsed, 4)
  assert.equal((await surrenders(w)).length, 0)
  const row = await stateOf(w)
  assert.equal(row.helpRung, 4)
  assert.equal(row.maxRung, 4)
  assert.equal(row.hintsOpened, 3)
  // The button stays: the worked example is still allowed, and delivered later it does surrender.
  assert.equal(result.body.state.workedAllowed, true)
  await run(w, { event: 'show_worked', attempts: ['25'] }, fakes().deps)
  assert.equal((await surrenders(w)).length, 1)
  assert.equal((await stateOf(w)).helpRung, 5)
})

dbTest('show answer after a miss writes the surrender, flagged as a reveal, once', async () => {
  const w = await world()
  await withConceptSteps(w)
  await run(w, { event: 'check', answer: '25' })
  const f = fakes()
  const shown = await run(w, { event: 'reveal' }, f.deps)
  assert.equal(shown.status, 'ok')
  assert.equal(f.calls.length, 0)
  const rows = await surrenders(w)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].metadata, { maxRung: 5, surrendered: true, reveal: true, contentId: rows[0].itemKey.split(':')[1], problemIndex: 0, step: 1 })
  assert.equal((await stateOf(w)).helpRung, 5)
  await run(w, { event: 'reveal' })
  assert.equal((await surrenders(w)).length, 1)
})

dbTest('a miss and an I do not know send back what to read: the pointer for the step\'s concepts', async () => {
  const w = await world()
  await withConceptSteps(w)
  const miss = await run(w, { event: 'check', answer: '25' })
  assert.equal(miss.status === 'ok' && miss.body.help?.pointers[0]?.conceptName, 'Rates')
  const idk = await run(w, { event: 'dont_know' })
  assert.equal(idk.status === 'ok' && idk.body.help?.pointers.length, 1)
  const right = await run(w, { event: 'check', answer: '30' })
  assert.equal(right.status === 'ok' && right.body.help, undefined)
  const read = await mod.readPracticeTutorState(w.user.id, { id: w.topic.id }, { problemIndex: 0, problemTitle: 'P1', stepIndex: 1 })
  assert.match(read?.contentId ?? '', /^[0-9a-f-]{36}$/)
})
