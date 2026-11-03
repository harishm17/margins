import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_COURSE_TERMS, selectCourseTerms, sessionTopicIds } from './course-terms'

test('concept names come first, then salient terms from the claims, without duplicates', () => {
  const terms = selectCourseTerms({
    conceptNames: ['Hash function', 'Collision', 'hash function'],
    claimTexts: [
      'A collision happens when two keys share a bucket, and chaining resolves it with a "linked list" in each bucket.',
      'Open addressing probes the next slot; the load factor is entries divided by buckets, as Knuth showed for LIFO and O(n) cases.',
      'Rehashing doubles the capacity and reinserts every key, so amortised cost stays constant.',
    ],
  })
  assert.deepEqual(terms.slice(0, 2), ['Hash function', 'Collision'])
  for (const wanted of ['linked list', 'Knuth', 'LIFO', 'amortised', 'Rehashing']) {
    assert.ok(terms.some((term) => term.toLowerCase() === wanted.toLowerCase()), wanted)
  }
  assert.equal(new Set(terms.map((term) => term.toLowerCase())).size, terms.length)
  assert.equal(terms.some((term) => /^(however|because|between)$/i.test(term)), false)
})

test('at most 100 terms, concept names first, none with tags or line breaks', () => {
  const conceptNames = Array.from({ length: 60 }, (_, i) => `Concept ${i}`)
  const claimTexts = Array.from({ length: 200 }, (_, i) => `The quantity "term${i} <b>x</b>" relates to Superlongword${i}abc and ACRO${i}.`)
  const terms = selectCourseTerms({ conceptNames, claimTexts })
  assert.equal(terms.length, MAX_COURSE_TERMS)
  assert.deepEqual(terms.slice(0, 60), conceptNames)
  assert.equal(terms.some((term) => /[<>\n]/.test(term)), false)
  assert.equal(selectCourseTerms({ conceptNames: Array.from({ length: 150 }, (_, i) => `Name ${i}`), claimTexts: [] }).length, MAX_COURSE_TERMS)
})

test('nothing to go on gives no terms', () => {
  assert.deepEqual(selectCourseTerms({ conceptNames: [], claimTexts: [] }), [])
})

test('a session works on its topic, or on the topics of a sprint\'s questions', () => {
  assert.deepEqual(sessionTopicIds({ topicId: 't1', questionSet: [] }), ['t1'])
  assert.deepEqual(sessionTopicIds({ topicId: null, questionSet: [{ topic_id: 'a' }, { topic_id: 'b' }, { topic_id: 'a' }, {}] }).sort(), ['a', 'b'])
})
