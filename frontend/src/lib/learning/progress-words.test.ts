import test from 'node:test'
import assert from 'node:assert/strict'
import { IDEA_RECALL_WORDS, PROGRESS_GLOSSARY, PROGRESS_MEASURE, TOPIC_PROGRESS_WORDS } from './progress-words'
import { MASTERY_LABELS } from '../mastery'

test('topic bands and idea bands never share a word that means two things', () => {
  // "Getting there" is the one deliberate overlap: it is the middle band of both scales.
  const topic = new Set<string>(Object.values(TOPIC_PROGRESS_WORDS))
  for (const word of ['Solid', 'Shaky']) assert.ok(!topic.has(word), `${word} is an idea word`)
  const idea = new Set<string>(Object.values(IDEA_RECALL_WORDS))
  for (const word of ['Strong', 'Learning']) assert.ok(!idea.has(word), `${word} is a topic word`)
})

test('mastery labels come from the glossary', () => {
  assert.deepEqual(MASTERY_LABELS, TOPIC_PROGRESS_WORDS)
})

test('the glossary names each measure by its one name', () => {
  assert.match(PROGRESS_GLOSSARY.topic, new RegExp(PROGRESS_MEASURE.topic))
  assert.match(PROGRESS_GLOSSARY.idea, new RegExp(PROGRESS_MEASURE.idea))
  assert.match(PROGRESS_GLOSSARY.quiz, new RegExp(PROGRESS_MEASURE.quiz))
})
