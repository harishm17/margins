import test from 'node:test'
import assert from 'node:assert/strict'
import { onDemandQuizPreferences } from './quiz-band'

const base = { question_count: 6, difficulty_level: 'medium' as const, focus: 'Concepts you missed: queues', concept_ids: ['c1'] }

test('new set difficulty follows the band', () => {
  assert.equal(onDemandQuizPreferences(base, 0).difficulty_level, 'easy')
  assert.equal(onDemandQuizPreferences(base, 1).difficulty_level, 'medium')
  assert.equal(onDemandQuizPreferences(base, 2).difficulty_level, 'hard')
  // A topic with no band keeps the plan difficulty.
  assert.equal(onDemandQuizPreferences(base, null).difficulty_level, 'medium')
  assert.equal(onDemandQuizPreferences(base, null, 'hard').difficulty_level, 'hard')
})

test('the rest of the plan is kept, and a harder set is hard whatever the band', () => {
  const easy = onDemandQuizPreferences(base, 0)
  assert.equal(easy.question_count, 6)
  assert.equal(easy.focus, base.focus)
  assert.deepEqual(easy.concept_ids, ['c1'])
  assert.equal(onDemandQuizPreferences(base, 0, 'hard').difficulty_level, 'hard')
})
