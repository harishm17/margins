import assert from 'node:assert/strict'
import test from 'node:test'
import { filterConceptQuestions, hasMath, normalizeVoiceQuestion, type VoiceQuestion } from './concept'

const question = (extra: Partial<VoiceQuestion>): VoiceQuestion => normalizeVoiceQuestion({ question_type: 'multiple_choice', question_text: 'Q', ...extra }) as VoiceQuestion

test('a bare number is not math', () => {
  for (const text of ['Why is a hash lookup O(1) on average?', 'What happens in step 2 of the algorithm?', 'A tree with 5 nodes has how many edges, and why?']) {
    assert.equal(hasMath(text), false, text)
  }
})

test('working that cannot be said aloud is math', () => {
  for (const text of ['Compute 3 + 4', 'What is 12 / 4?', 'Solve for x', 'If x = 5, what is y?', 'Find 15% of 80', 'Use the formula for the area', 'What is √9?']) {
    assert.equal(hasMath(text), true, text)
  }
})

test('a quiz question with digits in its explanation or tags is still asked', () => {
  const kept = filterConceptQuestions([
    question({ question_text: 'Why is binary search faster than a scan?', explanation: 'It halves the range each time: log2(n) steps, not n.', concepts_tested: ['O(log n)', 'step 1'] }),
    question({ question_text: 'Mock idea 1', correct_answer: 'A', options: [{ id: 'A', text: 'Mock option 1' }] }),
  ])
  assert.equal(kept.length, 2)
})

test('numerical questions and spoken calculations are left out', () => {
  const kept = filterConceptQuestions([
    question({ question_type: 'numerical', question_text: 'How many?' }),
    question({ question_text: 'Calculate the load factor' }),
    question({ question_text: 'Why use a hash table?' }),
  ])
  assert.deepEqual(kept.map((item) => item.question_text), ['Why use a hash table?'])
})
