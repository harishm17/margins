import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallEvidence, recallLevel } from './recall-evidence'

test('the level an answer is recorded at', () => {
  assert.deepEqual(recallLevel({ abandoned: false }, 0.9), { assistance: 0, score: 0.9 })
  assert.deepEqual(recallLevel({ abandoned: true }, 0.2), { assistance: 2, score: 0.2 })
  assert.deepEqual(recallLevel({ abandoned: false, repeat: 'seen' }, 0.75), { assistance: 2, score: 0.75 })
  assert.deepEqual(recallLevel({ abandoned: false, repeat: 'seen' }, 0.5), { assistance: 1, score: 0 })
  assert.deepEqual(recallLevel({ abandoned: false, repeat: 'revealed' }, 1), { assistance: 3, score: 0 })
  assert.deepEqual(recallLevel({ abandoned: true, repeat: 'revealed' }, 1), { assistance: 3, score: 0 })
})

test('recall evidence is one event per concept with the learner model metadata', () => {
  const events = recallEvidence({
    userId: 'u',
    projectId: 'p',
    topicId: 't',
    kind: 'teach_back',
    itemKey: 'teach_back:t:c1',
    attemptId: 'a1',
    abandoned: false,
    scores: [
      { conceptId: 'c1', score: 0.5, missKind: 'misconception', misconception: 'wrong idea' },
      { conceptId: 'c2', score: 1 },
    ],
  })
  assert.deepEqual(events.map((e) => [e.conceptIds, e.source, e.assistance, e.gradedBy, e.score]), [
    [['c1'], 'teach_back', 0, 'model', 0.5],
    [['c2'], 'teach_back', 0, 'model', 1],
  ])
  assert.deepEqual(events[0].metadata, { mode: 'recall', attemptId: 'a1', missKind: 'misconception', misconception: 'wrong idea' })
})

test("an I don't remember is a level-1 failure whatever else is set", () => {
  assert.deepEqual(recallLevel({ abandoned: false, idk: true }, 0), { assistance: 1, score: 0 })
  assert.deepEqual(recallLevel({ abandoned: true, idk: true }, 0), { assistance: 1, score: 0 })
  assert.deepEqual(recallLevel({ abandoned: false, repeat: 'revealed', idk: true }, 0), { assistance: 1, score: 0 })
})
