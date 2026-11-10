import assert from 'node:assert/strict'
import test from 'node:test'
import { examGuard, examQuestionTexts, tokens } from './exam-guard'

const open = ['Which data structure gives constant average time lookup by key?', 'Explain why quicksort is slower than merge sort on sorted input.']

test('guard blocks pasted exam question', () => {
  assert.equal(examGuard('Which data structure gives constant average time lookup by key?', open), true)
  // Pasted with a lead-in and different case, punctuation and spacing.
  assert.equal(examGuard('can you help: WHICH data structure gives constant   average time lookup by key', open), true)
  // The second question, reworded only a little.
  assert.equal(examGuard('why is quicksort slower than merge sort on sorted input', open), true)
})

test('guard allows related concept question', () => {
  assert.equal(examGuard('What is a hash table?', open), false)
  assert.equal(examGuard('How does quicksort pick its pivot?', open), false)
  assert.equal(examGuard('Explain hashing and collisions', open), false)
})

test('guard has nothing to compare against without an open exam or a question with words in it', () => {
  assert.equal(examGuard('Which data structure gives constant average time lookup by key?', []), false)
  assert.equal(examGuard('', open), false)
  assert.equal(examGuard('the of and', ['is a the']), false)
})

test('accents typed as a letter and as a letter plus a mark are the same word, in any script, in capitals or not', () => {
  const spanish = ['¿Cuál es la relación de transmisión según la información: más dientes en el plato o en el piñón? Explícalo con precisión.']
  assert.deepEqual([...tokens('Café NAÏVE')].sort(), [...tokens('Cafe\u0301 NAI\u0308VE')].sort())
  assert.equal(examGuard(spanish[0].normalize('NFD').toUpperCase(), spanish), true)
  assert.equal(examGuard('Explica qué es una relación de transmisión', spanish), false)
  // Greek and Cyrillic words are words, and a final sigma lowercases the same way in both languages.
  assert.deepEqual([...tokens('ΣΟΦΟΣ Привет-мир x²')].sort(), ['x²', 'мир', 'привет', 'σοφος'].sort())
})

test('a question with its options is compared as one text too', () => {
  const texts = examQuestionTexts([{ question_text: 'Pick the stable sort', options: ['Merge sort', 'Heap sort', 'Quick sort', 'Selection sort'].map((text, index) => ({ id: 'ABCD'[index], text })) }])
  assert.equal(texts.length, 2)
  assert.equal(examGuard('A Merge sort B Heap sort C Quick sort D Selection sort Pick the stable sort', texts), true)
  assert.equal(examGuard('Pick the stable sort', texts), true)
})

const gears = [
  'A rider uses a chainring with 48 teeth and a rear cog with 16 teeth. The wheel has a circumference of 2.1 metres and the rider pedals at 80 rpm. What is the gear ratio?',
  'Which of the two gears is not suitable for climbing? Explain why a harder gear raises the speed more than a lighter one.',
]

test('guard blocks a paste with a long lead-in that drowns the question in Jaccard', () => {
  const message = `I am really stuck on this revision question, my friend says it is tricky and I have been staring at it for an hour, could you work through it step by step for me tonight: ${gears[0]}`
  assert.equal(examGuard(message, gears), true)
})

test('guard blocks a paraphrase that keeps most of the content words', () => {
  assert.equal(examGuard('Given a rider on a chainring with 48 teeth and a rear cog with 16 teeth, wheel circumference 2.1 metres, pedalling at 80 rpm, what gear ratio is that', gears), true)
})

test('guard keeps negations and comparatives as content: a flipped question is still that question, a different one is not', () => {
  assert.ok(tokens('Which gear is not suitable?').has('not'))
  assert.ok(tokens('harder than lighter').has('than'))
  assert.equal(examGuard('Which of the two gears is suitable for climbing? Explain why a harder gear raises the speed more than a lighter one.', gears), true)
  assert.equal(examGuard('Explain what a gear ratio is', gears), false)
  assert.equal(examGuard('What does a gear ratio of 3 mean for a rider?', gears), false)
})

test('a short exam question is only matched by Jaccard, so a few common words do not decline a concept question', () => {
  assert.equal(examGuard('Why does a hash table need a good hash function and what is a bucket?', ['Define hash table.']), false)
})

test('guard reads the last messages together with this one: a question asked in pieces is the question', () => {
  const exam = ['Compute the probability that two marbles drawn without replacement from a bag of 3 red and 5 blue marbles are both red.']
  const pieces = ['two marbles drawn without replacement', 'from a bag of 3 red and 5 blue marbles']
  assert.equal(examGuard(pieces[0], exam), false)
  assert.equal(examGuard(pieces[1], exam), false)
  assert.equal(examGuard('they are red', exam, [pieces[0]]), false)
  assert.equal(examGuard('probability they are both red', exam, pieces), true)
  // Only the last few messages count, and an unrelated conversation does not add up to a question.
  assert.equal(examGuard(pieces[1], exam, ['what is a marble', 'unrelated', 'unrelated again', 'and another']), false)
  assert.equal(examGuard('What is the median of a list?', open, ['what is a hash table', 'tell me about quicksort']), false)
})
