/**
 * Running the waiting step before the model speaks (spec §19.1) against a real, migrated Postgres (DATABASE_URL), in every
 * style. The recall grader and the quiz grader are fakes. Each test is a student turn as the route runs it: the words are
 * stored (`beginVoiceTurn`), the rules choose the step (`planPreRunForSession`), the step runs (`runPreRun`), and a second
 * run of the same step by the model gets the stored result.
 */
import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { RecallClaimVerdict, RecallGradeAnswer, RecallGradeRequest } from '@/lib/ai-service/recall'
import type { VoiceMessage } from './history'

let prisma: typeof import('@/lib/db/prisma').prisma
let tools: typeof import('./tools')
let teach: typeof import('./teach-tools')
let server: typeof import('./pre-run-server')
let available = false
const userIds: string[] = []
const realFetch = globalThis.fetch

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  tools = await import('./tools')
  teach = await import('./teach-tools')
  server = await import('./pre-run-server')
  available = await prisma.$queryRaw`SELECT coach_state FROM voice_drill_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
})
afterEach(() => {
  globalThis.fetch = realFetch
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

type Rule = Partial<RecallClaimVerdict> & { verdict: RecallClaimVerdict['verdict'] }
function grader(rules: Record<string, Rule>) {
  const asked: RecallGradeRequest[] = []
  const grade = async (request: RecallGradeRequest): Promise<RecallGradeAnswer> => {
    asked.push(request)
    return {
      status: 'graded',
      confidence: 0.9,
      verdicts: request.claims.map((claim) => {
        const rule = Object.entries(rules).find(([prefix]) => claim.text.startsWith(prefix))?.[1] ?? { verdict: 'missing' as const }
        return { claim_id: claim.id, student_quote: null, ...rule }
      }),
    }
  }
  return { grade, asked }
}
const COVERED: Rule = { verdict: 'covered', student_quote: 'said it' }

function stubQuizGrader(share: number) {
  const calls: unknown[] = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')))
    const graded = [{ question_index: 0, question_type: 'short_answer', points_possible: 1, points_earned: share, is_correct: share >= 0.7, feedback: 'ok', needs_review: false }]
    return new Response(JSON.stringify({ graded_questions: graded, total_points: 1, earned_points: share, overall_score: share * 100, needs_review: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}

async function world(style: 'teach_back' | 'guided_reading' | 'oral_quiz') {
  const user = await prisma.user.create({ data: { email: `pr-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'notes.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  const collision = await prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name: 'Collision', summary: 'c', kind: 'concept', orderIndex: 0 } })
  for (const [index, text, page] of [[0, 'Two keys that share a bucket collide.', 4], [1, 'Chaining keeps a list in each bucket.', 5]] as const) {
    await prisma.conceptClaim.create({ data: { conceptId: collision.id, text, quote: `Quote: ${text}`, materialId: material.id, orderIndex: index, pageStart: page } })
  }
  const question = (text: string) => ({ question_type: 'conceptual', question_text: text, sample_answer: 'The answer.', key_points: ['point'], concept_ids: [collision.id], topic_id: topic.id })
  const session = await prisma.voiceDrillSession.create({
    data: { userId: user.id, projectId: project.id, topicId: topic.id, style, questionSet: style === 'oral_quiz' ? [question('q0'), question('q1'), question('q2')] : [], connectedAt: new Date() },
  })
  return { user, project, topic, collision, session }
}
type World = Awaited<ReturnType<typeof world>>

/** One student turn as the route runs it: store the words, choose the step, run it. */
async function turn(w: World, utterance: string, history: VoiceMessage[] = [], grade?: Parameters<typeof server.runPreRun>[1]['grade'], steps: import('./tools').StepCache = new Map()) {
  const number = await teach.beginVoiceTurn(w.session.id, utterance)
  const plan = await server.planPreRunForSession({ userId: w.session.userId, sessionId: w.session.id, language: 'en', utterance, history })
  const ctx = { sessionId: w.session.id, userId: w.user.id, timeZone: 'UTC', turn: number, steps, grade }
  return { number, plan, steps, ctx, ran: plan ? await server.runPreRun(plan, ctx) : null }
}
/** The coach's side: a tool the model called in its own turn (the first call, which asks the question). */
const coachCalls = async (w: World, name: string, args: unknown = {}) => {
  const number = await teach.beginVoiceTurn(w.session.id, '')
  return tools.executeVoiceTool({ sessionId: w.session.id, userId: w.user.id, timeZone: 'UTC', turn: number }, name, args)
}
const stateOf = async (w: World) => (await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: w.session.id } })).coachState as any
const evidence = (w: World, source: string) => prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source }, orderBy: { createdAt: 'asc' } })
const out = (value: { output: unknown } | undefined | null) => value!.output as Record<string, any>

dbTest('teach-back: the explanation is assessed before the model speaks, once, with the gates of the tool', async () => {
  const w = await world('teach_back')
  await coachCalls(w, 'get_concept_to_explain')
  const g = grader({ 'Two keys': COVERED, Chaining: { verdict: 'missing', pointer: 'Look again at p. 5: what does each bucket hold?' } })
  const first = await turn(w, 'Two keys that land in one bucket collide.', [], g.grade)
  assert.equal(first.plan?.tool, 'assess_explanation')
  const result = out(first.ran?.result)
  assert.equal(result.action, 'probe')
  assert.equal(result.probe.number, 1)
  // T8: the claim that was left out is not in what the model is given.
  assert.equal(JSON.stringify(first.ran?.block).includes('Chaining keeps a list'), false)
  assert.match(String(first.ran?.block.text), /^<app_result step="assess_explanation">/)
  assert.equal((await evidence(w, 'teach_back')).length, 1)
  assert.equal(g.asked.length, 1)
  // The model asks for the same step anyway: the stored result, no second grading, no second record.
  const again = await tools.executeVoiceTool({ ...first.ctx }, 'assess_explanation', { concept_id: w.collision.id })
  assert.deepEqual(again.output, first.ran?.result.output)
  assert.deepEqual(again.events, [])
  assert.equal(g.asked.length, 1)
  assert.equal(await prisma.recallAttempt.count({ where: { userId: w.user.id } }), 1)
  assert.equal((await stateOf(w)).teach.concepts[w.collision.id].assessments, 1)
})

dbTest('teach-back: a plain "I don\'t know" is not graded and the first gap is explained at once', async () => {
  const w = await world('teach_back')
  await coachCalls(w, 'get_concept_to_explain')
  const g = grader({})
  const idk = await turn(w, "I don't know", [], g.grade)
  assert.equal(out(idk.ran?.result).action, 'explain_first')
  assert.equal(g.asked.length, 0)
  assert.equal((await evidence(w, 'teach_back')).length, 1)

  // Asks and short replies run nothing.
  const x = await world('teach_back')
  await coachCalls(x, 'get_concept_to_explain')
  const h = grader({})
  for (const said of ['just tell me the answer', 'okay', 'what does collide mean', 'hmm']) {
    const t = await turn(x, said, [], h.grade)
    assert.equal(t.plan, null, said)
  }
  assert.equal(h.asked.length, 0)
  // The words since the prompt are all of them, as for the tool: the chatter above is part of what the grader reads.
  const chatty = await turn(x, "I don't know", [], h.grade)
  assert.equal(chatty.plan?.tool, 'assess_explanation')
  assert.equal(h.asked.length, 1)
})

dbTest('teach-back: the new example is graded against the words the coach used, after a full-coverage explanation', async () => {
  const w = await world('teach_back')
  await coachCalls(w, 'get_concept_to_explain')
  const g = grader({ 'Two keys': COVERED, Chaining: COVERED })
  const full = await turn(w, 'Two keys in a bucket collide and chaining keeps a list in each bucket.', [], g.grade)
  assert.equal(out(full.ran?.result).action, 'ask_new_example')
  const history: VoiceMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: 'Nice. Suppose three keys share one bucket: how would chaining store them?' }] }]
  const check = await turn(w, 'They would sit in a list in that bucket, one after another.', history, g.grade)
  assert.equal(check.plan?.tool, 'record_check')
  assert.equal(g.asked[g.asked.length - 1].prompt, 'Nice. Suppose three keys share one bucket: how would chaining store them?')
  assert.equal(out(check.ran?.result).passed, true)
  assert.equal((await evidence(w, 'voice')).length, 1)
  const again = await tools.executeVoiceTool({ ...check.ctx }, 'record_check', { concept_id: w.collision.id, question: 'something else' })
  assert.deepEqual(again.output, check.ran?.result.output)
  assert.equal((await evidence(w, 'voice')).length, 1)
})

dbTest('teach-back: a retry of a turn that already carries its result runs nothing', async () => {
  const w = await world('teach_back')
  await coachCalls(w, 'get_concept_to_explain')
  const history: VoiceMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'text', text: '<app_result step="assess_explanation">{}</app_result>' }] }]
  const t = await turn(w, 'Two keys in one bucket collide.', history, grader({}).grade)
  assert.equal(t.plan, null)
})

dbTest('guided reading: the prediction reveals the claim with a check question, and the answer is checked', async () => {
  const w = await world('guided_reading')
  const asked = await coachCalls(w, 'next_claim')
  assert.equal(out(asked).done, false)
  const none = await turn(w, 'skip this one')
  assert.equal(none.plan, null)
  assert.equal((await stateOf(w)).guided.stage, 'predicting')
  const predicted = await turn(w, 'Probably something about two keys sharing a spot.')
  assert.equal(predicted.plan?.step, 'reveal')
  const revealed = out(predicted.ran?.result)
  assert.equal(revealed.claim.text, '<source_claim>Two keys that share a bucket collide.</source_claim>')
  assert.match(revealed.instruction, /In your own words, what do your pages say about "Collision"\?/)
  assert.equal(predicted.ran?.result.events[0].type, 'board')
  const again = await tools.executeVoiceTool({ ...predicted.ctx }, 'next_claim', { reveal: true, check_question: 'My own question?' })
  assert.deepEqual(again.output, predicted.ran?.result.output)
  assert.equal((await stateOf(w)).guided.checkQuestion, 'In your own words, what do your pages say about "Collision"?')
  const g = grader({ 'Two keys': COVERED })
  const checked = await turn(w, 'Keys that share a bucket collide.', [], g.grade)
  assert.equal(checked.plan?.tool, 'record_check')
  assert.equal(out(checked.ran?.result).verdict, 'right')
  assert.equal((await evidence(w, 'voice')).length, 1)
  assert.equal(g.asked.length, 1)
})

dbTest('oral quiz: the answer is recorded and graded once before the model speaks; confidence questions and follow-ups wait for the model', async () => {
  const w = await world('oral_quiz')
  const calls = stubQuizGrader(1)
  await coachCalls(w, 'get_next_question')
  const answered = await turn(w, 'Keys are mapped to buckets by a hash function.')
  assert.deepEqual(answered.plan, { step: 'record_answer', tool: 'record_answer', input: { question_index: 0 } })
  assert.equal(out(answered.ran?.result).is_correct, true)
  assert.equal(calls.length, 1)
  assert.equal(await prisma.voiceDrillAttempt.count({ where: { sessionId: w.session.id } }), 1)
  assert.equal((await evidence(w, 'voice')).length, 1)
  const again = await tools.executeVoiceTool({ ...answered.ctx }, 'record_answer', { question_index: 0 })
  assert.deepEqual(again.output, answered.ran?.result.output)
  assert.equal(calls.length, 1)
  assert.equal(await prisma.learningSignal.count({ where: { userId: w.user.id } }), 1)
  // The follow-up to the feedback is not an answer to a new question.
  assert.equal((await turn(w, 'Because the hash gives the index directly.')).plan, null)
  // Question 1, then question 2, which asks "How sure are you?" before it is recorded.
  await coachCalls(w, 'get_next_question')
  assert.equal((await turn(w, 'a list per bucket')).plan?.input.question_index, 1)
  await coachCalls(w, 'get_next_question')
  assert.equal((await turn(w, 'resizing the table when it fills up')).plan, null)
  assert.equal((await turn(w, "I don't know")).plan?.input.idk, true)
})

// The point of spec 19.1: a graded utterance is one model call, and the browser hears of the step before the model speaks.
dbTest('a graded teach-back utterance makes one model call (it made two), and a request makes one too', async () => {
  const { runTurn } = await import('./turn-engine')
  const w = await world('teach_back')
  await coachCalls(w, 'get_concept_to_explain')
  const g = grader({ 'Two keys': COVERED, Chaining: { verdict: 'missing', pointer: 'p. 5' } })
  const speaks = [{ type: 'text' as const, delta: 'Good start. What does each bucket hold?' }, { type: 'done' as const, stopReason: 'end_turn', content: [{ type: 'text', text: 'Good start. What does each bucket hold?' }] }]
  async function play(utterance: string) {
    const emitted: unknown[] = []
    const sent: VoiceMessage[][] = []
    const number = await teach.beginVoiceTurn(w.session.id, utterance)
    const steps: import('./tools').StepCache = new Map()
    let messages: VoiceMessage[] = [{ role: 'user', content: utterance }]
    const plan = await server.planPreRunForSession({ userId: w.session.userId, sessionId: w.session.id, language: 'en', utterance, history: [] })
    const ctx = { sessionId: w.session.id, userId: w.user.id, timeZone: 'UTC', turn: number, steps, grade: g.grade }
    if (plan) messages = (await server.startWithPreRun(plan, ctx, messages, (event) => emitted.push(event))).messages
    const outcome = await runTurn(
      {
        // The model speaks at once when the result is in its message; otherwise it asks for the tool first, as it did.
        async openModel(sentMessages, call) {
          sent.push(sentMessages)
          const hasResult = JSON.stringify(sentMessages).includes('<app_result')
          async function* events() {
            if (hasResult || call > 1 || !plan) {
              for (const event of speaks) yield event
            }
          }
          if (!hasResult && call === 1) {
            return (async function* () {
              yield { type: 'done' as const, stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'assess_explanation', input: { concept_id: w.collision.id } }] }
            })()
          }
          return events()
        },
        runTool: (name, input) => tools.executeVoiceTool({ ...ctx, steps: steps }, name, input),
        emit: (event) => emitted.push(event),
        log: () => undefined,
      },
      messages
    )
    return { calls: sent.length, emitted, outcome }
  }
  const graded = await play('Two keys that land in one bucket collide.')
  assert.equal(graded.calls, 1)
  assert.deepEqual((graded.emitted[0] as { type: string }).type, 'working')
  assert.equal(graded.outcome.text, 'Good start. What does each bucket hold?')
  assert.equal(g.asked.length, 1)
  const request = await play('can you say that again')
  assert.equal(request.calls, 2, 'a request is not an answer: no step is run before the model, which then asks for a tool as before')
})
