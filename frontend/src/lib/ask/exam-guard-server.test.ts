import assert from 'node:assert/strict'
import test from 'node:test'
import { EXAM_GUARD_NOTE, guardingExam, type OpenExam } from './exam-guard-server'

const exam: OpenExam = { examId: 'e1', texts: ['Which data structure gives constant average time lookup by key?'] }
const exams = async () => [exam]
const never = async () => {
  throw new Error('the meaning check should not run')
}

test('the word check decides first, and the meaning check is not asked', async () => {
  const found = await guardingExam('u', 'p', 'Which data structure gives constant average time lookup by key?', [], { exams, semantic: never })
  assert.equal(found?.examId, 'e1')
})

test('a message the words pass goes to the meaning check, with the student\'s earlier messages and the exam texts', async () => {
  const calls: unknown[] = []
  const semantic = async (input: unknown) => {
    calls.push(input)
    return true
  }
  const history = [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'a reply' },
    { role: 'user', content: EXAM_GUARD_NOTE },
  ]
  const found = await guardingExam('u', 'p', 'Una estructura de datos con busqueda en tiempo constante?', history, { exams, semantic })
  assert.equal(found?.examId, 'e1')
  assert.deepEqual(calls, [{ message: 'Una estructura de datos con busqueda en tiempo constante?', recent: ['earlier question'], examTexts: exam.texts }])
})

test('a message that is neither by words nor by meaning goes on', async () => {
  assert.equal(await guardingExam('u', 'p', 'What is a hash table?', [], { exams, semantic: async () => false }), undefined)
})

test('with no exam in progress nothing is checked', async () => {
  assert.equal(await guardingExam('u', 'p', 'anything', [], { exams: async () => [], semantic: never }), undefined)
})

test('the words read the earlier messages too', async () => {
  const history = [{ role: 'user', content: 'which data structure gives' }, { role: 'user', content: 'constant average time' }]
  const found = await guardingExam('u', 'p', 'lookup by key?', history, { exams, semantic: async () => false })
  assert.equal(found?.examId, 'e1')
})
