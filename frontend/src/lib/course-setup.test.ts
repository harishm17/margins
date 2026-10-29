import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSetup, needsTopicReview, topicOriginSentence, readyToStudy, type CourseSetupInput } from './course-setup'

// An active course with five topics found in the files, all confirmed, and some content.
const base: CourseSetupInput = {
  status: 'active',
  materialCount: 2,
  topicCount: 5,
  confirmedTopicCount: 5,
  extractedTopicCount: 5,
  confirmedExtractedTopicCount: 5,
  contentBlockCount: 8,
  extraction: 'done',
}

const fresh: CourseSetupInput = {
  ...base,
  status: 'setup',
  topicCount: 0,
  confirmedTopicCount: 0,
  extractedTopicCount: 0,
  confirmedExtractedTopicCount: 0,
  contentBlockCount: 0,
  extraction: 'none',
}

const shape = (input: CourseSetupInput) => {
  const setup = deriveSetup(input)
  return { mode: setup.mode, step: setup.step, label: setup.label }
}

test('no materials is step 1', () => {
  assert.deepEqual(shape({ ...fresh, materialCount: 0 }), { mode: 'setup', step: 1, label: 'Upload materials' })
})

test('materials and no topics: step 2, named after the latest search for topics', () => {
  assert.deepEqual(shape(fresh), { mode: 'setup', step: 2, label: 'Finding topics' })
  assert.equal(deriveSetup({ ...fresh, extraction: 'running' }).label, 'Finding topics')
  // A failed search does not say it is still finding: the student retries or adds topics by hand.
  assert.equal(deriveSetup({ ...fresh, extraction: 'failed' }).label, 'Add topics')
  assert.equal(deriveSetup({ ...fresh, extraction: 'done' }).label, 'Find topics')
})

test('found topics not confirmed yet are step 2, review', () => {
  const setup = deriveSetup({ ...fresh, status: 'topics_pending', topicCount: 5, extractedTopicCount: 5 })
  assert.equal(setup.step, 2)
  assert.equal(setup.label, 'Review topics')
  assert.equal(readyToStudy(setup), false)
  assert.equal(needsTopicReview(setup), true)
  assert.equal(topicOriginSentence(setup.topics), 'We found 5 topics in your files.')
})

test('topics added by hand only: confirmed one by one, but the list is not until Confirm', () => {
  const manual = { ...fresh, topicCount: 2, confirmedTopicCount: 2, extraction: 'failed' as const }
  const setup = deriveSetup(manual)
  assert.deepEqual(shape(manual), { mode: 'setup', step: 2, label: 'Confirm topics' })
  assert.equal(readyToStudy(setup), false)
  assert.equal(needsTopicReview(setup), true)
  assert.equal(setup.topics.manual, 2)
  assert.equal(setup.topics.extracted, 0)
  assert.equal(topicOriginSentence(setup.topics), 'You added 2 topics.')

  // Confirm sets the status: step 3, and the list is confirmed everywhere.
  const confirmed = deriveSetup({ ...manual, status: 'active' })
  assert.deepEqual(shape({ ...manual, status: 'active' }), { mode: 'setup', step: 3, label: 'Start studying' })
  assert.equal(readyToStudy(confirmed), true)
  assert.equal(needsTopicReview(confirmed), false)
})

test('found and hand-added topics: "found" counts only the found ones', () => {
  const setup = deriveSetup({ ...fresh, status: 'topics_pending', topicCount: 6, confirmedTopicCount: 1, extractedTopicCount: 5 })
  assert.equal(setup.label, 'Review topics')
  assert.equal(topicOriginSentence(setup.topics), 'We found 5 topics in your files and you added 1 topic.')
  assert.equal(setup.topics.newSinceConfirm, 0)
})

test('new topics found after the list was confirmed: back to step 2 until they are confirmed', () => {
  // The planner sets topics_pending when it adds topics to a confirmed course.
  const input = { ...base, status: 'topics_pending', topicCount: 8, confirmedTopicCount: 5, extractedTopicCount: 8 }
  const setup = deriveSetup(input)
  assert.deepEqual(shape(input), { mode: 'setup', step: 2, label: 'Review topics' })
  assert.equal(setup.topics.newSinceConfirm, 3)
  assert.equal(topicOriginSentence(setup.topics), 'We found 3 new topics in your files.')
  // A status that says active with an unconfirmed topic still is not a confirmed list.
  assert.equal(deriveSetup({ ...input, status: 'active' }).step, 2)
})

test('a confirmed course whose topics were all deleted is back to step 2', () => {
  const setup = deriveSetup({ ...base, topicCount: 0, confirmedTopicCount: 0, extractedTopicCount: 0, confirmedExtractedTopicCount: 0, contentBlockCount: 0 })
  assert.equal(setup.step, 2)
  assert.equal(readyToStudy(setup), false)
  assert.equal(needsTopicReview(setup), false)
})

test('confirmed topics without content is step 3', () => {
  assert.deepEqual(shape({ ...base, contentBlockCount: 0 }), { mode: 'setup', step: 3, label: 'Start studying' })
})

test('confirmed topics with some content is active', () => {
  assert.deepEqual(shape(base), { mode: 'active', step: null, label: null })
  assert.equal(deriveSetup({ ...base, status: 'completed' }).mode, 'active')
  assert.equal(readyToStudy(deriveSetup(base)), true)
})

test('the last file deleted after Confirm, nothing written yet: back to step 1, not ready to study', () => {
  const input = { ...base, materialCount: 0, contentBlockCount: 0 }
  const setup = deriveSetup(input)
  assert.deepEqual(shape(input), { mode: 'setup', step: 1, label: 'Upload materials' })
  // The list itself stays confirmed (the Topics page shows it, not the editor), but nothing can be written from it.
  assert.equal(setup.topics.listConfirmed, true)
  assert.equal(readyToStudy(setup), false)
  assert.equal(needsTopicReview(setup), false)
})

test('the last file deleted after studying: topics, content and progress stay, so the course stays set up', () => {
  const setup = deriveSetup({ ...base, materialCount: 0 })
  assert.equal(setup.mode, 'active')
  assert.equal(readyToStudy(setup), true)
})

test('no files but content, list not confirmed (hand-added topics opened before this fix): step 2, confirm', () => {
  const setup = deriveSetup({ ...fresh, materialCount: 0, topicCount: 2, confirmedTopicCount: 2, contentBlockCount: 3 })
  assert.equal(setup.step, 2)
  assert.equal(setup.label, 'Confirm topics')
  assert.equal(readyToStudy(setup), false)
})
