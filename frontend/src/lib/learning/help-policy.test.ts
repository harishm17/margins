import assert from 'node:assert/strict'
import test from 'node:test'
import { SECOND_CHECK_SCORE, canOpenHint, firstTryRecord, hintCostLabel } from './help-policy'
import type { Rung } from './practice-evidence'

type Step = Parameters<typeof firstTryRecord>[0]

const none: Step = {
  checks: 0,
  firstCheckCorrect: false,
  solvedOnCheck: null,
  helpRungBeforeSolve: 0,
  twoOption: false,
  dontKnow: false,
  revealed: false,
  workedDelivered: false,
  finished: false,
}
const step = (over: Partial<Step>): Step => ({ ...none, ...over })

// The ten sequences of spec 18.4, as the server sees each one at the end.
const SEQUENCES: { name: string; step: Step | null; expected: { assistance: 0 | 1; score: number } | null }[] = [
  { name: '1 right on the first check', step: step({ checks: 1, firstCheckCorrect: true, solvedOnCheck: 1 }), expected: { assistance: 0, score: 1 } },
  { name: '2 locate, then right on the first check', step: step({ checks: 1, firstCheckCorrect: true, solvedOnCheck: 1, helpRungBeforeSolve: 1 }), expected: { assistance: 0, score: 0.6 } },
  { name: '3 wrong, then right with no help', step: step({ checks: 2, solvedOnCheck: 2 }), expected: { assistance: 0, score: 0.6 } },
  { name: '4 wrong, locate, then right', step: step({ checks: 2, solvedOnCheck: 2, helpRungBeforeSolve: 1 }), expected: { assistance: 0, score: 0.6 } },
  // 5 (connect before any check) cannot happen: see the gate tests.
  { name: '6 wrong, connect, then right', step: step({ checks: 2, solvedOnCheck: 2, helpRungBeforeSolve: 3 }), expected: { assistance: 1, score: 0 } },
  { name: '7 IDK, connect, structure, then right', step: step({ checks: 2, dontKnow: true, solvedOnCheck: 2, helpRungBeforeSolve: 4 }), expected: { assistance: 1, score: 0 } },
  { name: '8 wrong, worked example delivered, finished', step: step({ checks: 1, workedDelivered: true, helpRungBeforeSolve: 5, finished: true }), expected: { assistance: 1, score: 0 } },
  { name: '9 wrong, worked example fell back to the structure hint, then right', step: step({ checks: 2, solvedOnCheck: 2, helpRungBeforeSolve: 4 }), expected: { assistance: 1, score: 0 } },
  { name: '10 wrong, Show answer', step: step({ checks: 1, revealed: true, finished: true }), expected: { assistance: 1, score: 0 } },
]

test('help policy ordering holds for every sequence', () => {
  for (const { name, step: input, expected } of SEQUENCES) {
    const record = firstTryRecord(input!)
    assert.ok(record, name)
    assert.deepEqual({ assistance: record.assistance, score: record.score }, expected, name)
  }
  // The ten rows are ordered: no sequence in which the student asked for more help than another, after the same
  // tries, scores higher than it. (Rows 1 > 2 = 3 = 4 > 6 = 7 = 8 = 9 = 10.)
  const score = (i: number) => firstTryRecord(SEQUENCES[i].step!)!.score
  const [r1, r2, r3, r4, r6, r7, r8, r9, r10] = SEQUENCES.map((_, i) => score(i))
  assert.ok(r1 > r2)
  assert.ok(r2 === r3 && r3 === r4)
  assert.ok(r4 > r6)
  for (const later of [r6, r7, r8, r9, r10]) assert.equal(later, 0)
})

test('trying first is never scored below asking first or giving up', () => {
  const rungs: Rung[] = [0, 1, 2, 3, 4, 5]
  const records: { input: Step; score: number; assistance: number }[] = []
  for (const checks of [1, 2, 3, 4])
    for (const solvedOnCheck of [null, 1, 2, 3, 4] as const)
      for (const rung of rungs)
        for (const twoOption of [false, true])
          for (const dontKnow of [false, true])
            for (const revealed of [false, true])
              for (const workedDelivered of [false, true]) {
                if (solvedOnCheck !== null && solvedOnCheck > checks) continue
                const input = step({ checks, firstCheckCorrect: solvedOnCheck === 1, solvedOnCheck, helpRungBeforeSolve: rung, twoOption, dontKnow, revealed, workedDelivered, finished: true })
                const record = firstTryRecord(input)!
                assert.ok([0, SECOND_CHECK_SCORE, 1].includes(record.score), 'a score is 0, 0.6 or 1')
                if (record.assistance === 1) assert.equal(record.score, 0, 'a failed first try scores 0')
                records.push({ input, ...record })
              }
  for (const a of records) {
    // More help never scores higher: lift the rung, or ask for the worked example, or Show answer.
    for (const patch of [{ helpRungBeforeSolve: Math.min(5, a.input.helpRungBeforeSolve + 1) as Rung }, { workedDelivered: true }, { revealed: true }, { dontKnow: true }]) {
      const more = firstTryRecord({ ...a.input, ...patch })!
      assert.ok(more.score <= a.score, `${JSON.stringify(a.input)} + ${JSON.stringify(patch)}`)
    }
    // Giving up (never solved) is never above solving.
    if (a.input.solvedOnCheck !== null) {
      const gaveUp = firstTryRecord({ ...a.input, solvedOnCheck: null })!
      assert.ok(gaveUp.score <= a.score)
    }
  }
})

test('third check success is level 1', () => {
  assert.deepEqual(firstTryRecord(step({ checks: 3, solvedOnCheck: 3 })), { assistance: 1, score: 0, decided: true })
  assert.deepEqual(firstTryRecord(step({ checks: 4, solvedOnCheck: 4 })), { assistance: 1, score: 0, decided: true })
})

test('second check on true false is level 1', () => {
  assert.deepEqual(firstTryRecord(step({ checks: 2, solvedOnCheck: 2, twoOption: true })), { assistance: 1, score: 0, decided: true })
  // A first check on a two-option item is still a first try.
  assert.deepEqual(firstTryRecord(step({ checks: 1, firstCheckCorrect: true, solvedOnCheck: 1, twoOption: true })), { assistance: 0, score: 1, decided: true })
})

test('dont know decides level 1 at once', () => {
  // IDK is the step's first check, wrong; the record is final before any help or any finish.
  assert.deepEqual(firstTryRecord(step({ checks: 1, dontKnow: true })), { assistance: 1, score: 0, decided: true })
  // And it stays level 1 when the student then solves it with no help at all.
  assert.deepEqual(firstTryRecord(step({ checks: 2, dontKnow: true, solvedOnCheck: 2 })), { assistance: 1, score: 0, decided: true })
})

test('one wrong check is not decided', () => {
  assert.deepEqual(firstTryRecord(step({ checks: 1 })), { assistance: 1, score: 0, decided: false })
  assert.deepEqual(firstTryRecord(step({ checks: 1, helpRungBeforeSolve: 1 })), { assistance: 1, score: 0, decided: false })
  // Left behind, it is final.
  assert.equal(firstTryRecord(step({ checks: 1, finished: true }))!.decided, true)
  // Help above locate, a second wrong check, or a wrong check on a two-option item cannot be undone.
  assert.equal(firstTryRecord(step({ checks: 1, helpRungBeforeSolve: 3 }))!.decided, true)
  assert.equal(firstTryRecord(step({ checks: 2 }))!.decided, true)
  assert.equal(firstTryRecord(step({ checks: 1, twoOption: true }))!.decided, true)
})

test('no checks gives null', () => {
  assert.equal(firstTryRecord(none), null)
  // Opened a hint but never checked: no attempt, nothing written (spec 18.13 Q3).
  assert.equal(firstTryRecord(step({ helpRungBeforeSolve: 1 })), null)
})

test('hints 2 and 3 need an attempt, locate does not', () => {
  assert.equal(canOpenHint(0, false), true)
  assert.equal(canOpenHint(1, false), false)
  assert.equal(canOpenHint(2, false), false)
  assert.equal(canOpenHint(1, true), true)
  assert.equal(canOpenHint(2, true), true)
})

test('hint cost labels', () => {
  assert.equal(hintCostLabel(0, { attempted: false, failedFirstTry: false }), 'still_counts_harder')
  assert.equal(hintCostLabel(0, { attempted: true, failedFirstTry: false }), 'still_counts_harder')
  assert.equal(hintCostLabel(1, { attempted: true, failedFirstTry: false }), 'counts_as_miss')
  assert.equal(hintCostLabel(2, { attempted: true, failedFirstTry: false }), 'counts_as_miss')
  for (const index of [0, 1, 2] as const) assert.equal(hintCostLabel(index, { attempted: true, failedFirstTry: true }), 'no_extra_cost')
})
