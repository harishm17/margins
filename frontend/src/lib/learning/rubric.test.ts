import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRubric, } from './rubric'

const written = { question_type: 'short_answer', key_points: ['Names the idea', 'Gives a reason'] }

test('a written answer is listed with a verdict per line when the grader gave one for each', () => {
  const rubric = buildRubric(written, [
    { point: 'Names the idea', result: 'met' },
    { point: 'Gives a reason', result: 'partly' },
  ])
  assert.deepEqual(rubric, [
    { text: 'Names the idea', result: 'met' },
    { text: 'Gives a reason', result: 'partly' },
  ])
})

test('other question types and questions without key points have no rubric', () => {
  assert.equal(buildRubric({ question_type: 'multiple_choice', key_points: ['x'] }, []), null)
  assert.equal(buildRubric({ question_type: 'short_answer', key_points: [] }, []), null)
  assert.equal(buildRubric({ question_type: 'short_answer' }, []), null)
})
