import assert from 'node:assert/strict'
import test from 'node:test'
import { EMPTY_TUTOR_STATE, type StoredTutorState } from '@/lib/tutor/store'
import { isNewProblem, isRepeat, nextUnderstand, planAskTurn, replyTaught, rungUsed, tutorEventFor, understandModeFor, type AskPlan, type UnderstandCounter, type UnderstandInput } from './ask-turn'
import type { AskRoute } from './tutor-message'

const state = (overrides: Partial<StoredTutorState> = {}): StoredTutorState => ({ ...EMPTY_TUTOR_STATE, conceptIds: [], ...overrides })
const route = (overrides: Partial<AskRoute> = {}): AskRoute => ({
  intent: 'solve',
  hasAttempt: false,
  wantsAnswer: false,
  concepts: [],
  conceptIds: [],
  broad: false,
  degraded: false,
  ...overrides,
})
const planOf = (
  before: StoredTutorState,
  question = 'I tried integrating by parts but the limits look wrong',
  kind: 'ask' | 'show_worked' = 'ask',
  understand?: UnderstandInput
): AskPlan => {
  const planned = planAskTurn(before, question, kind, [], understand)
  assert.ok(planned.ok)
  return planned.plan
}

test('a first message is answered at rung 0 and an attempt would climb one rung', () => {
  const { tutor } = planOf(state())
  assert.deepEqual(tutor, {
    rung: 0,
    final_allowed: false,
    ask_what_is_unclear: false,
    attempt_rung: 1,
    attempt_ask_what_is_unclear: false,
    understand_mode: 'commit',
    attempt_understand_mode: 'explain',
  })
})

test('a short message is not an attempt, so it does not climb', () => {
  assert.equal(planOf(state(), 'just tell me').tutor.attempt_rung, 0)
  assert.equal(planOf(state(), 'idk').tutor.attempt_rung, 0)
})

test('the third low-effort turn asks which part is unclear, whichever way the router reads it', () => {
  const { tutor } = planOf(state({ lowEffortTurns: 2 }), 'help')
  assert.equal(tutor.ask_what_is_unclear, true)
  assert.equal(tutor.attempt_ask_what_is_unclear, true)
})

test('final_allowed is never true for Ask: it has no key and a self-grade is not proof', () => {
  assert.equal(planOf(state({ checkedCorrect: false })).tutor.final_allowed, false)
  assert.equal(planOf(state({ checkedCorrect: true })).tutor.final_allowed, false)
})

test('rung 5 belongs to the button: the next ordinary message is answered at structure at most', () => {
  const before = state({ rung: 5, maxRung: 5, attempts: 2 })
  const { tutor } = planOf(before)
  assert.equal(tutor.rung, 4)
  assert.equal(tutor.attempt_rung, 4)
})

test('the worked example needs one genuine attempt, and is then rung 5 with nothing confirmed', () => {
  assert.deepEqual(planAskTurn(state(), 'show me', 'show_worked'), { ok: false, reason: 'not_allowed' })
  const { tutor } = planOf(state({ attempts: 1, rung: 1, checkedCorrect: true }), 'show me', 'show_worked')
  assert.deepEqual(tutor, { rung: 5, final_allowed: false, ask_what_is_unclear: false, attempt_rung: 5, attempt_ask_what_is_unclear: false, show_worked: true })
})

test('one event per student turn, only for solve turns: checking an answer does not climb the ladder', () => {
  const plan = planOf(state())
  assert.deepEqual(tutorEventFor(plan, route({ intent: 'solve', hasAttempt: true })), { type: 'attempt', text: plan.question })
  assert.deepEqual(tutorEventFor(plan, route({ intent: 'solve', hasAttempt: false })), { type: 'request' })
  for (const intent of ['check_answer', 'lookup', 'logistics', 'understand', 'other'] as const) assert.equal(tutorEventFor(plan, route({ intent })), null, intent)
  assert.equal(tutorEventFor(plan, route({ degraded: true })), null)
})

test('the worked-example button is one show_worked event, and only when the reply was a solve', () => {
  const plan = planOf(state({ attempts: 1 }), 'show me', 'show_worked')
  assert.deepEqual(tutorEventFor(plan, route({ intent: 'solve' })), { type: 'show_worked' })
  assert.equal(tutorEventFor(plan, route({ intent: 'lookup' })), null)
})

test('the rung a reply used follows what the router found', () => {
  const plan = planOf(state())
  assert.equal(rungUsed(plan, route({ hasAttempt: false })), 0)
  assert.equal(rungUsed(plan, route({ hasAttempt: true })), 1)
  assert.equal(rungUsed(planOf(state({ attempts: 1 }), 'x', 'show_worked'), route()), 5)
})

test('only a reply that taught records level 3', () => {
  const plan = planOf(state())
  assert.equal(replyTaught(plan, route({ intent: 'understand', hasAttempt: true }), 'end_turn'), true)
  // A question back, the places to start, and a lookup teach nothing yet.
  assert.equal(replyTaught(plan, route({ intent: 'understand', hasAttempt: false }), 'end_turn'), false)
  assert.equal(replyTaught(plan, route({ intent: 'understand', hasAttempt: true, broad: true }), 'end_turn'), false)
  assert.equal(replyTaught(plan, route({ intent: 'lookup' }), 'end_turn'), false)
  assert.equal(replyTaught(plan, route({ intent: 'check_answer', hasAttempt: true }), 'end_turn'), false)
  // A solve reply teaches once it gives structure (rung 4) or a worked example (rung 5).
  assert.equal(replyTaught(plan, route({ intent: 'solve', hasAttempt: true }), 'end_turn'), false)
  assert.equal(replyTaught(planOf(state({ rung: 3, attempts: 3 })), route({ intent: 'solve', hasAttempt: true }), 'end_turn'), true)
  assert.equal(replyTaught(planOf(state({ attempts: 1 }), 'x', 'show_worked'), route({ intent: 'solve' }), 'end_turn'), true)
  // The fixed reply that asks for the work gave nothing.
  assert.equal(replyTaught(plan, route({ intent: 'understand', hasAttempt: true }), 'leak_fallback'), false)
})

const PROBLEM = 'A rider uses a chainring with 48 teeth and a rear cog with 16 teeth. What is the gear ratio?'
const OTHER_PROBLEM = 'A savings account holds 1,500 dollars and pays 4 percent interest once a year. What is the balance after 5 years?'

test('a new problem is a long statement with a quantity that has little in common with the thread, and is not their own work', () => {
  assert.equal(isNewProblem(OTHER_PROBLEM, [PROBLEM, 'I tried 48 / 16 and got 3']), true)
  assert.equal(isNewProblem('Can you solve this for me? ' + OTHER_PROBLEM, [PROBLEM]), true)
  // The student's own work on the same problem, a follow-up, a short question and a first message are not.
  assert.equal(isNewProblem('I tried dividing 48 by 16 over and over and got 3, but I am not sure that is the ratio', [PROBLEM]), false)
  assert.equal(isNewProblem('I think the interest of 4 percent on 1,500 dollars each year for 5 years adds up to something', [PROBLEM]), false)
  assert.equal(isNewProblem('what about 48 teeth', [PROBLEM]), false)
  assert.equal(isNewProblem(OTHER_PROBLEM, []), false)
  assert.equal(isNewProblem('Why does the chainring matter for the speed of the rider overall', [PROBLEM]), false)
})

test('a new problem starts the ladder again: the reply is written at rung 0 and the stored state is reset afterwards', () => {
  const climbed = state({ rung: 3, maxRung: 3, attempts: 3, lowEffortTurns: 2, checkedCorrect: true, conceptIds: ['c1'] })
  const planned = planAskTurn(climbed, OTHER_PROBLEM, 'ask', [PROBLEM])
  assert.ok(planned.ok)
  assert.equal(planned.plan.fresh, true)
  assert.deepEqual(planned.plan.tutor, { rung: 0, final_allowed: false, ask_what_is_unclear: false, attempt_rung: 1, attempt_ask_what_is_unclear: false, understand_mode: 'commit', attempt_understand_mode: 'explain' })
  assert.deepEqual(planned.plan.before.conceptIds, ['c1'])
  // The same message with no new problem in it keeps the ladder.
  const same = planAskTurn(climbed, 'I tried 48 divided by 16 and got 3', 'ask', [PROBLEM])
  assert.ok(same.ok && !same.plan.fresh && same.plan.tutor.rung === 3)
  // The worked-example button never resets.
  assert.ok(planAskTurn(climbed, 'x', 'show_worked', [PROBLEM]).ok)
})

test('an attempt that repeats an earlier message is only a request: repeating it cannot climb the ladder', () => {
  const prior = ['I tried dividing 48 by 16 and got 3']
  const plan = { kind: 'ask' as const, question: '  i tried dividing 48 by 16 and got 3 ', prior }
  assert.deepEqual(tutorEventFor(plan, route({ hasAttempt: true })), { type: 'request' })
  assert.deepEqual(tutorEventFor({ ...plan, question: 'I tried dividing 48 by 16 and got 3, but the ratio seems too small' }, route({ hasAttempt: true })), {
    type: 'attempt',
    text: 'I tried dividing 48 by 16 and got 3, but the ratio seems too small',
  })
  assert.equal(isRepeat('I tried dividing 48 by 16 and got 3!', prior), true)
  assert.equal(isRepeat('A different idea about teeth', prior), false)
  assert.equal(isRepeat('', prior), false)
})

const un = (noAttempt: number, band: 0 | 1 | 2 = 1, concepts: string[] = ['c1']): UnderstandInput => ({ noAttempt, concepts, band })
const understand = (overrides: Partial<AskRoute> = {}) => route({ intent: 'understand', conceptIds: ['c1'], ...overrides })

test('two non-attempt understand turns give explain_short', () => {
  assert.equal(understandModeFor(un(0)), 'commit')
  assert.equal(understandModeFor(un(1)), 'commit')
  assert.equal(understandModeFor(un(2)), 'explain_short')
  assert.equal(planOf(state(), 'idk', 'ask', un(2)).tutor.understand_mode, 'explain_short')
  assert.equal(planOf(state(), 'idk', 'ask', un(1)).tutor.understand_mode, 'commit')
  // The count builds up one turn at a time, on the same concepts.
  let counter: UnderstandCounter = { noAttempt: 0, concepts: [] }
  counter = nextUnderstand(counter, understand(), 'commit')
  counter = nextUnderstand(counter, understand(), 'commit')
  assert.deepEqual(counter, { noAttempt: 2, concepts: ['c1'] })
  assert.equal(understandModeFor({ ...counter, band: 1 }), 'explain_short')
})

test('band 0 explains after one', () => {
  assert.equal(understandModeFor(un(0, 0)), 'commit')
  assert.equal(understandModeFor(un(1, 0)), 'explain_short')
  assert.equal(understandModeFor(un(1, 1)), 'commit')
  assert.equal(understandModeFor(un(1, 2)), 'commit')
})

test('an attempt resets the count', () => {
  assert.deepEqual(nextUnderstand({ noAttempt: 3, concepts: ['c1'] }, understand({ hasAttempt: true }), 'explain'), { noAttempt: 0, concepts: ['c1'] })
})

test('new concepts restart the count at 1', () => {
  assert.deepEqual(nextUnderstand({ noAttempt: 3, concepts: ['c1'] }, understand({ conceptIds: ['c2'] }), 'commit'), { noAttempt: 1, concepts: ['c2'] })
  // Overlap with any earlier concept keeps counting; the first turn of a thread has none to overlap.
  assert.deepEqual(nextUnderstand({ noAttempt: 1, concepts: ['c1'] }, understand({ conceptIds: ['c1', 'c2'] }), 'commit'), { noAttempt: 2, concepts: ['c1', 'c2'] })
  assert.deepEqual(nextUnderstand({ noAttempt: 0, concepts: [] }, understand({ conceptIds: ['c9'] }), 'commit'), { noAttempt: 1, concepts: ['c9'] })
})

test('an explain_short reply resets the count, and a broad, degraded or other-intent turn does not count', () => {
  assert.deepEqual(nextUnderstand({ noAttempt: 2, concepts: ['c1'] }, understand(), 'explain_short'), { noAttempt: 0, concepts: ['c1'] })
  const same = { noAttempt: 1, concepts: ['c1'] }
  assert.deepEqual(nextUnderstand(same, understand({ broad: true }), 'entry_points'), same)
  assert.deepEqual(nextUnderstand(same, understand({ degraded: true }), 'commit'), same)
  assert.deepEqual(nextUnderstand(same, route({ intent: 'solve' }), 'commit'), same)
  assert.deepEqual(nextUnderstand(same, route({ intent: 'lookup' }), 'commit'), same)
})

test('explain_short teaches: level 3 like every Ask explanation', () => {
  const short = planOf(state(), 'idk', 'ask', un(2))
  assert.equal(replyTaught(short, understand(), 'end_turn'), true)
  // The same state read by a router that found a broad question or failed teaches nothing.
  assert.equal(replyTaught(short, understand({ broad: true }), 'end_turn'), false)
  assert.equal(replyTaught(short, understand({ degraded: true }), 'end_turn'), false)
  assert.equal(replyTaught(planOf(state(), 'idk', 'ask', un(1)), understand(), 'end_turn'), false)
})
