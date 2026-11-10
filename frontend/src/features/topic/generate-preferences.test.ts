import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPreferences, defaultForm, validateForm } from './generate-preferences'

test('more examples append and carry a trimmed focus', () => {
  const form = { ...defaultForm('more'), focus: '  cycles  ' }
  assert.deepEqual(buildPreferences('examples', form, 'more'), {
    count: 2,
    difficulty_level: 'medium',
    focus: 'cycles',
    append: true,
  })
  assert.deepEqual(buildPreferences('practice', defaultForm('create'), 'create'), {
    count: 3,
    difficulty_level: 'medium',
  })
})

test('quiz sends the type list only when it is a subset', () => {
  const all = buildPreferences('quiz', defaultForm('regenerate'), 'regenerate')
  assert.equal('question_types' in all, false)
  assert.equal(all.question_count, 10)
  const some = buildPreferences('quiz', { ...defaultForm('regenerate'), types: ['numerical'] }, 'regenerate')
  assert.deepEqual(some.question_types, ['numerical'])
})

test('a focus needs 3 characters and a quiz needs a type', () => {
  assert.ok(validateForm('examples', { ...defaultForm('create'), focus: 'ab' }).focus)
  assert.equal(validateForm('examples', { ...defaultForm('create'), focus: '' }).focus, undefined)
  assert.equal(validateForm('notes', { ...defaultForm('create'), focus: 'ab' }).focus, undefined)
  assert.ok(validateForm('quiz', { ...defaultForm('create'), types: [] }).types)
  assert.equal(validateForm('quiz', defaultForm('create')).types, undefined)
})
