import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORED_HINT_RUNG } from '@/lib/learning/practice-evidence'
import { applyTutorEvent, gateHelp, isBareGuess, isGenuineAttempt, nextChecks, nextCounters, nextMove, nextRung, type AppliedState, type MoveState, type MoveSignals, type RungState } from './state'

const fresh: RungState = { rung: 0, maxRung: 0, attempts: 0, lowEffortTurns: 0, hintsOpened: 0 }
const GENUINE = 'I think the answer uses the second given value'

const moveState: MoveState = { rung: 1, attempts: 1, lowEffortTurns: 0, bareGuesses: 0, sameRungNoProgress: 0 }
const signals = (over: Partial<MoveSignals> = {}): MoveSignals => ({
  event: { type: 'attempt', text: GENUINE },
  lastWrong: false,
  justSolvedWithHints: false,
  ...over,
})

test('confront beats ladder on confident wrong', () => {
  assert.equal(nextMove(moveState, signals({ lastWrong: true, confident: true })), 'confront')
  assert.equal(nextMove(moveState, signals({ lastWrong: true })), 'ladder')
  assert.equal(nextMove(moveState, signals({ lastWrong: false, confident: true })), 'ladder')
})

test('confront on misconception miss', () => {
  assert.equal(nextMove(moveState, signals({ lastWrong: true, missKind: 'misconception' })), 'confront')
  assert.equal(nextMove(moveState, signals({ lastWrong: true, missKind: 'execution' })), 'ladder')
})

test('confirm after hinted success', () => {
  assert.equal(nextMove(moveState, signals({ justSolvedWithHints: true })), 'confirm')
})

test('two bare guesses require reasoning', () => {
  assert.equal(nextMove({ ...moveState, bareGuesses: 2 }, signals()), 'reason_first')
  assert.equal(nextMove({ ...moveState, bareGuesses: 1 }, signals()), 'ladder')
})

test('two stalled replies at one rung point to source', () => {
  assert.equal(nextMove({ ...moveState, sameRungNoProgress: 2 }, signals()), 'to_source')
  assert.equal(nextMove({ ...moveState, sameRungNoProgress: 1 }, signals()), 'ladder')
})

test('move precedence and the rest of the table', () => {
  assert.equal(nextMove({ ...moveState, bareGuesses: 3 }, signals({ event: { type: 'clarify' }, lastWrong: true, confident: true })), 'clarify')
  assert.equal(nextMove(moveState, signals({ event: { type: 'show_worked' } })), 'worked_analogue')
  assert.equal(nextMove({ ...moveState, attempts: 0 }, signals({ event: { type: 'show_worked' } })), 'ladder')
  assert.equal(nextMove({ ...moveState, rung: 0, attempts: 0 }, signals()), 'orient')
  assert.equal(
    nextMove({ ...moveState, bareGuesses: 2, sameRungNoProgress: 2 }, signals({ justSolvedWithHints: true })),
    'confirm'
  )
  assert.equal(nextMove({ ...moveState, bareGuesses: 2, sameRungNoProgress: 2 }, signals()), 'reason_first')
  assert.equal(nextMove({ ...moveState, rung: 0, sameRungNoProgress: 2 }, signals()), 'to_source')
})

test('request never raises rung', () => {
  const next = nextRung({ ...fresh, rung: 2, maxRung: 2, attempts: 1 }, { type: 'request' })
  assert.equal(next.rung, 2)
  assert.equal(next.maxRung, 2)
  assert.equal(next.attempts, 1)
  assert.equal(next.lowEffortTurns, 1)
})

test('genuine attempt raises by one', () => {
  const next = nextRung(fresh, { type: 'attempt', text: GENUINE })
  assert.equal(next.rung, 1)
  assert.equal(next.maxRung, 1)
  assert.equal(next.attempts, 1)
  const again = nextRung(next, { type: 'attempt', text: GENUINE })
  assert.equal(again.rung, 2)
})

test('an attempt never climbs past structure; rung 5 is the student\'s button', () => {
  let state = fresh
  for (let i = 0; i < 8; i++) state = { ...state, ...nextRung(state, { type: 'attempt', text: GENUINE }) }
  assert.equal(state.rung, 4)
})

test('a low-effort attempt does not climb or count', () => {
  const next = nextRung(fresh, { type: 'attempt', text: 'idk' })
  assert.equal(next.rung, 0)
  assert.equal(next.attempts, 0)
  assert.equal(next.lowEffortTurns, 1)
})

test('checked wrong answer counts as attempt', () => {
  const next = nextRung(fresh, { type: 'checked', correct: false })
  assert.equal(next.attempts, 1)
  assert.equal(next.rung, 1)
})

test('a correct check changes no rung and no attempt count', () => {
  const next = nextRung({ ...fresh, rung: 1, maxRung: 1, attempts: 1 }, { type: 'checked', correct: true })
  assert.equal(next.rung, 1)
  assert.equal(next.attempts, 1)
})

test('three low-effort turns ask what is unclear', () => {
  let state: RungState = fresh
  const flags: boolean[] = []
  for (const text of ['idk', 'hint', 'just tell me']) {
    const next = nextRung(state, { type: 'attempt', text })
    flags.push(next.askWhatIsUnclear)
    state = { ...state, ...next }
  }
  assert.deepEqual(flags, [false, false, true])
  assert.equal(state.rung, 0)
  const after = nextRung(state, { type: 'attempt', text: GENUINE })
  assert.equal(after.askWhatIsUnclear, false)
  assert.equal(after.lowEffortTurns, 0)
})

test('clarify changes no state', () => {
  const state: RungState = { rung: 2, maxRung: 3, attempts: 2, lowEffortTurns: 2, hintsOpened: 1 }
  const next = nextRung(state, { type: 'clarify' })
  assert.deepEqual({ rung: next.rung, maxRung: next.maxRung, attempts: next.attempts, lowEffortTurns: next.lowEffortTurns }, {
    rung: 2,
    maxRung: 3,
    attempts: 2,
    lowEffortTurns: 2,
  })
})

test('authored hint index maps to rung 1, 3, 4', () => {
  assert.deepEqual([...AUTHORED_HINT_RUNG], [1, 3, 4])
  assert.equal(nextRung(fresh, { type: 'hint_opened', index: 0 }).rung, 1)
  assert.equal(nextRung(fresh, { type: 'hint_opened', index: 1 }).rung, 3)
  assert.equal(nextRung(fresh, { type: 'hint_opened', index: 2 }).rung, 4)
  // never lowers a rung already reached
  const high = nextRung({ ...fresh, rung: 4, maxRung: 4 }, { type: 'hint_opened', index: 0 })
  assert.equal(high.rung, 4)
  assert.equal(high.maxRung, 4)
})

test('show worked refused before a genuine attempt', () => {
  const refused = nextRung(fresh, { type: 'show_worked' })
  assert.equal(refused.rung, 0)
  assert.equal(refused.workedAllowed, false)
  const lowEffort = nextRung(fresh, { type: 'attempt', text: 'idk' })
  const afterLowEffort = nextRung({ ...fresh, ...lowEffort }, { type: 'show_worked' })
  assert.equal(afterLowEffort.rung, 0)
  assert.equal(afterLowEffort.workedAllowed, false)
  const allowed = nextRung({ ...fresh, rung: 1, maxRung: 1, attempts: 1 }, { type: 'show_worked' })
  assert.equal(allowed.workedAllowed, true)
  assert.equal(allowed.rung, 5)
  assert.equal(allowed.maxRung, 5)
})

test('worked offered once at three failed attempts and never again', () => {
  let state: RungState = fresh
  const offers: boolean[] = []
  for (let i = 0; i < 5; i++) {
    const next = nextRung(state, { type: 'checked', correct: false })
    offers.push(next.offerWorked)
    state = { ...state, ...next }
  }
  assert.deepEqual(offers, [false, false, true, false, false])
})

test('maxRung only rises', () => {
  const state: RungState = { rung: 2, maxRung: 4, attempts: 1, lowEffortTurns: 0, hintsOpened: 0 }
  assert.equal(nextRung(state, { type: 'attempt', text: GENUINE }).maxRung, 4)
  assert.equal(nextRung(state, { type: 'request' }).maxRung, 4)
  assert.equal(nextRung(state, { type: 'hint_opened', index: 0 }).maxRung, 4)
})

test('idk variants are low effort', () => {
  for (const text of [
    'idk',
    'IDK',
    'Idk.',
    "i don't know",
    'I dont know',
    "I don’t know!",
    'just tell me',
    'Just tell me!',
    'give me the answer',
    'Give me the answer.',
    'hint',
    'Hint?',
    'help',
    '?',
    '???',
    '',
    '   ',
    'short',
  ])
    assert.equal(isGenuineAttempt(text), false, text)
  assert.equal(isGenuineAttempt('I think it is the second given'), true)
  assert.equal(isGenuineAttempt('  twelve chars  '), true)
  assert.equal(isGenuineAttempt('1234567890a'), false)
})

test('padded low-effort requests are still low effort', () => {
  for (const text of [
    'give me a hint',
    'Give me a hint please',
    'just tell me the answer',
    'i dont know the answer',
    "I don't know the answer.",
    'hint please',
    'can you just give me the answer pls',
    'plz help me',
    'no idea, sorry',
    'can you tell me the answer please',
  ])
    assert.equal(isGenuineAttempt(text), false, text)
})

test('hesitation and intensifier words do not make a request genuine', () => {
  for (const text of [
    'hmm i really dont know',
    'um uh i dont know',
    'honestly no idea',
    'well, actually i dont know',
    'ok so really just a hint please',
    'hmm, so what is the answer',
  ])
    assert.equal(isGenuineAttempt(text), false, text)
  // Reasoning stays genuine with the same words around it.
  assert.equal(isGenuineAttempt('hmm so I think the second given is the one to use'), true)
  assert.equal(isGenuineAttempt('actually the units cancel so it is 12 m'), true)
})

test('reasoning that mentions hint or dont know is genuine', () => {
  for (const text of [
    "I don't know if I should divide by 2 or multiply, I think divide",
    'the hint says to look at the second given, so I used 4',
    'I need a hint? No: the units cancel so it is 12 m',
  ])
    assert.equal(isGenuineAttempt(text), true, text)
})

test('isBareGuess is a short value with no reasoning, distinct from low effort', () => {
  for (const text of ['42', 'x = 3', 'B', '3.5 m/s', 'true', '  -7 ']) assert.equal(isBareGuess(text), true, text)
  for (const text of ['idk', 'hint', '?', '', 'I think it is 42 because of the second given']) assert.equal(isBareGuess(text), false, text)
})

const noGap = { gapId: null, prevGapId: null, progressed: false }

test('bare guesses count up and an attempt with reasoning resets them', () => {
  const prev = { bareGuesses: 0, sameRungNoProgress: 0 }
  const one = nextCounters(prev, { type: 'attempt', text: '42' }, { ...noGap, rungBefore: 0, rungAfter: 1 })
  assert.equal(one.bareGuesses, 1)
  const two = nextCounters(one, { type: 'attempt', text: '17' }, { ...noGap, rungBefore: 1, rungAfter: 2 })
  assert.equal(two.bareGuesses, 2)
  const idk = nextCounters(two, { type: 'attempt', text: 'idk' }, { ...noGap, rungBefore: 2, rungAfter: 2 })
  assert.equal(idk.bareGuesses, 2)
  const reasoned = nextCounters(two, { type: 'attempt', text: 'I used the second given to get 4' }, { ...noGap, rungBefore: 2, rungAfter: 3 })
  assert.equal(reasoned.bareGuesses, 0)
})

test('stalled replies reset on a rung change, a new gap or progress', () => {
  const prev = { bareGuesses: 0, sameRungNoProgress: 2 }
  const ev = { type: 'attempt', text: 'idk' } as const
  assert.equal(nextCounters(prev, ev, { ...noGap, rungBefore: 2, rungAfter: 2 }).sameRungNoProgress, 3)
  assert.equal(nextCounters(prev, ev, { ...noGap, rungBefore: 2, rungAfter: 3 }).sameRungNoProgress, 0)
  assert.equal(nextCounters(prev, ev, { gapId: 'b', prevGapId: 'a', progressed: false, rungBefore: 2, rungAfter: 2 }).sameRungNoProgress, 0)
  assert.equal(nextCounters(prev, ev, { gapId: 'a', prevGapId: 'a', progressed: false, rungBefore: 2, rungAfter: 2 }).sameRungNoProgress, 3)
  assert.equal(nextCounters(prev, ev, { ...noGap, progressed: true, rungBefore: 2, rungAfter: 2 }).sameRungNoProgress, 0)
  // clarify is free; a correct check is progress
  assert.equal(nextCounters(prev, { type: 'clarify' }, { ...noGap, rungBefore: 2, rungAfter: 2 }).sameRungNoProgress, 2)
  assert.equal(nextCounters(prev, { type: 'checked', correct: true }, { ...noGap, rungBefore: 2, rungAfter: 2 }).sameRungNoProgress, 0)
})

test('applyTutorEvent drives nextMove to reason_first', () => {
  let state: AppliedState = { ...fresh, bareGuesses: 0, sameRungNoProgress: 0 }
  state = applyTutorEvent(state, { type: 'attempt', text: '42', correct: false }, {})
  assert.equal(state.bareGuesses, 1)
  state = applyTutorEvent(state, { type: 'attempt', text: '17', correct: false }, {})
  assert.equal(state.bareGuesses, 2)
  assert.equal(nextMove(state, signals({ lastWrong: true })), 'reason_first')
  state = applyTutorEvent(state, { type: 'attempt', text: 'because the second given is 4 so I doubled it' }, {})
  assert.equal(state.bareGuesses, 0)
  assert.equal(nextMove(state, signals()), 'ladder')
})

test('applyTutorEvent drives nextMove to to_source', () => {
  // at rung 4 attempts cannot climb, so two stalled replies on the same gap point to the source
  let state: AppliedState = { ...fresh, rung: 4, maxRung: 4, attempts: 2, bareGuesses: 0, sameRungNoProgress: 0, gapId: 'step-2' }
  state = applyTutorEvent(state, { type: 'attempt', text: 'maybe it is the other formula then' }, { gapId: 'step-2' })
  assert.equal(state.sameRungNoProgress, 1)
  assert.equal(nextMove(state, signals()), 'ladder')
  state = applyTutorEvent(state, { type: 'attempt', text: 'I still think it is the other formula' }, { gapId: 'step-2' })
  assert.equal(state.sameRungNoProgress, 2)
  assert.equal(nextMove(state, signals()), 'to_source')
  // moving to another gap starts again
  state = applyTutorEvent(state, { type: 'attempt', text: 'now on step three I get 9' }, { gapId: 'step-3' })
  assert.equal(state.sameRungNoProgress, 0)
  assert.equal(state.gapId, 'step-3')
})

test('a submission with its text and a wrong check is one event and climbs one rung', () => {
  const next = nextRung(fresh, { type: 'attempt', text: 'I think it is the second given', correct: false })
  assert.equal(next.rung, 1)
  assert.equal(next.attempts, 1)
  const bareWrong = nextRung(fresh, { type: 'attempt', text: '42', correct: false })
  assert.equal(bareWrong.rung, 1)
  assert.equal(bareWrong.attempts, 1)
})

test('a correct check leaves rung, attempts and lowEffortTurns alone', () => {
  const state: RungState = { rung: 2, maxRung: 2, attempts: 2, lowEffortTurns: 2, hintsOpened: 0 }
  for (const event of [{ type: 'checked', correct: true }, { type: 'attempt', text: '42', correct: true }] as const) {
    const next = nextRung(state, event)
    assert.deepEqual([next.rung, next.attempts, next.lowEffortTurns], [2, 2, 2])
  }
})

test('hint_opened keeps the most hints seen and leaves lowEffortTurns alone', () => {
  const state: RungState = { rung: 4, maxRung: 4, attempts: 1, lowEffortTurns: 2, hintsOpened: 3 }
  const next = nextRung(state, { type: 'hint_opened', index: 0 })
  assert.equal(next.hintsOpened, 3)
  assert.equal(next.lowEffortTurns, 2)
  assert.equal(nextRung(fresh, { type: 'hint_opened', index: 1 }).hintsOpened, 2)
})

test('nextChecks counts checked answers from the server, not the browser', () => {
  const none = { checks: 0, wrongChecks: 0, lastCheckWrong: false, checkedCorrect: false }
  const one = nextChecks(none, { type: 'attempt', text: '5', correct: false })
  assert.deepEqual(one, { checks: 1, wrongChecks: 1, lastCheckWrong: true, checkedCorrect: false })
  const two = nextChecks(one, { type: 'checked', correct: false })
  assert.equal(two.wrongChecks, 2)
  const right = nextChecks(two, { type: 'attempt', text: '4', correct: true })
  assert.deepEqual(right, { checks: 3, wrongChecks: 2, lastCheckWrong: false, checkedCorrect: true })
  // Reasoning without a check, hints and clarifying are not checks.
  for (const event of [{ type: 'attempt', text: 'I think the ratio is wrong here' }, { type: 'request' }, { type: 'clarify' }, { type: 'hint_opened', index: 0 }] as const) {
    assert.deepEqual(nextChecks(right, event), right)
  }
  // The right answer once given stays given, even if a later check is wrong.
  assert.equal(nextChecks(right, { type: 'checked', correct: false }).checkedCorrect, true)
})

test('an empty wrong check earns no rung and counts as no check', () => {
  const start = { rung: 0, maxRung: 0, attempts: 0, lowEffortTurns: 0, hintsOpened: 0 } as const
  const empty = nextRung(start, { type: 'attempt', text: '   ', correct: false })
  assert.deepEqual([empty.rung, empty.attempts, empty.workedAllowed], [0, 0, false])
  const real = nextRung(start, { type: 'attempt', text: '25', correct: false })
  assert.deepEqual([real.rung, real.attempts], [1, 1])
  const counts = { checks: 0, wrongChecks: 0, lastCheckWrong: false, checkedCorrect: false }
  assert.deepEqual(nextChecks(counts, { type: 'attempt', text: '', correct: false }), counts)
  assert.equal(nextChecks(counts, { type: 'attempt', text: '25', correct: false }).checks, 1)
})

// ---------------------------------------------------------------------------------------------- v3.1 (spec 18.3, 18.4)

test('dont_know counts as an attempt and does not climb', () => {
  const state: RungState = { ...fresh, rung: 1, maxRung: 1 }
  const next = nextRung(state, { type: 'dont_know' })
  assert.equal(next.attempts, 1)
  assert.equal(next.rung, 1)
  assert.equal(next.maxRung, 1)
  assert.equal(next.lowEffortTurns, 0)
  assert.equal(next.askWhatIsUnclear, false)
  // A second one is a second attempt, still no climb.
  assert.equal(nextRung(next, { type: 'dont_know' }).attempts, 2)
  assert.equal(nextRung(next, { type: 'dont_know' }).rung, 1)
})

test('worked allowed after dont_know', () => {
  assert.equal(nextRung(fresh, { type: 'show_worked' }).workedAllowed, false)
  const afterIdk = nextRung(fresh, { type: 'dont_know' })
  assert.equal(afterIdk.workedAllowed, true)
  assert.equal(nextRung(afterIdk, { type: 'show_worked' }).rung, 5)
})

test('dont_know is the first check, wrong', () => {
  const none = { checks: 0, wrongChecks: 0, lastCheckWrong: false, checkedCorrect: false }
  assert.deepEqual(nextChecks(none, { type: 'dont_know' }), { checks: 1, wrongChecks: 1, lastCheckWrong: true, checkedCorrect: false })
})

test('connect before attempt is refused', () => {
  const noChecks = { checks: 0 }
  assert.deepEqual(gateHelp(noChecks, { type: 'hint_opened', index: 1 }), { ok: false, code: 'ATTEMPT_FIRST' })
  assert.deepEqual(gateHelp(noChecks, { type: 'hint_opened', index: 2 }), { ok: false, code: 'ATTEMPT_FIRST' })
  assert.deepEqual(gateHelp(noChecks, { type: 'show_worked' }), { ok: false, code: 'ATTEMPT_FIRST' })
  assert.deepEqual(gateHelp(noChecks, { type: 'reveal' }), { ok: false, code: 'ATTEMPT_FIRST' })
  // Locate is open from the start, and anything else is not gated.
  assert.deepEqual(gateHelp(noChecks, { type: 'hint_opened', index: 0 }), { ok: true })
  assert.deepEqual(gateHelp(noChecks, { type: 'attempt', text: 'x' }), { ok: true })
  assert.deepEqual(gateHelp(noChecks, { type: 'dont_know' }), { ok: true })
  assert.deepEqual(gateHelp(noChecks, { type: 'clarify' }), { ok: true })
  // After one check (or an IDK, which is one) the help opens.
  for (const event of [{ type: 'hint_opened', index: 1 }, { type: 'hint_opened', index: 2 }, { type: 'show_worked' }, { type: 'reveal' }] as const) {
    assert.deepEqual(gateHelp({ checks: 1 }, event), { ok: true })
  }
})

test('tutor low-effort detection unchanged', () => {
  for (const text of ['idk', 'I dont know', 'no idea', 'just tell me', 'give me the answer', 'hint', '?', '???', 'please just tell me the answer']) {
    assert.equal(isGenuineAttempt(text), false, text)
  }
  assert.equal(isGenuineAttempt('I think the answer uses the second given value'), true)
  assert.equal(isBareGuess('42'), true)
  assert.equal(isBareGuess('idk'), false)
})
