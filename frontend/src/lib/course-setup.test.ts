import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSetup, deriveSetupStep, filesStepDone, needsTopicReview, newTopicsLabel, topicOriginSentence, readyToStudy, type CourseSetupInput } from './course-setup'

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

test('new topics found on an active course: it stays active, the new ones wait for review', () => {
  // The planner leaves the status alone once the course is active.
  const input = { ...base, topicCount: 8, extractedTopicCount: 8 }
  const setup = deriveSetup(input)
  assert.deepEqual(shape(input), { mode: 'active', step: null, label: null })
  assert.equal(readyToStudy(setup), true)
  assert.equal(setup.topics.listConfirmed, true)
  assert.equal(setup.topics.unconfirmed, 3)
  assert.equal(setup.topics.newSinceConfirm, 3)
  assert.equal(needsTopicReview(setup), true)
  assert.equal(newTopicsLabel(setup.topics), '3 new topics to review')
  assert.equal(newTopicsLabel(deriveSetup({ ...input, topicCount: 6, extractedTopicCount: 6 }).topics), '1 new topic to review')
  assert.equal(topicOriginSentence(setup.topics), 'We found 3 new topics in your files.')
  // Same while the course is at step 3 (confirmed, nothing written yet) and when it is completed.
  assert.equal(deriveSetup({ ...input, contentBlockCount: 0 }).step, 3)
  assert.equal(deriveSetup({ ...input, status: 'completed' }).mode, 'active')
  // Nothing new: no label, no dot.
  assert.equal(newTopicsLabel(deriveSetup(base).topics), null)
  assert.equal(needsTopicReview(deriveSetup(base)), false)
})

test('an active course whose confirmed topics are all gone, only new ones left: back to step 2', () => {
  const input = { ...base, topicCount: 3, confirmedTopicCount: 0, extractedTopicCount: 3, confirmedExtractedTopicCount: 0, contentBlockCount: 0 }
  const setup = deriveSetup(input)
  assert.deepEqual(shape(input), { mode: 'setup', step: 2, label: 'Review topics' })
  assert.equal(setup.topics.listConfirmed, false)
  assert.equal(readyToStudy(setup), false)
  assert.equal(needsTopicReview(setup), true)
  assert.equal(newTopicsLabel(setup.topics), null)
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

test('the sidebar and the setup page share one step: files still being read keep step 1', () => {
  const step = (over: Partial<Parameters<typeof deriveSetupStep>[0]>) => deriveSetupStep({ step: 2, materialCount: 1, filesDone: true, ...over })
  // Uploaded but not all read: the page and the sidebar both stay on step 1.
  assert.equal(step({ filesDone: false }), 1)
  // Read: step 2 stands.
  assert.equal(step({}), 2)
  // No files at all (a course with content only) keeps its step; other steps are never moved.
  assert.equal(step({ materialCount: 0, filesDone: false }), 2)
  assert.equal(deriveSetupStep({ step: 3, materialCount: 2, filesDone: false }), 3)
  assert.equal(deriveSetupStep({ step: 1, materialCount: 2, filesDone: true }), 1)
})

test('files step is done once a file is usable and the rest are read or topics are on their way', () => {
  const done = (over: Partial<Parameters<typeof filesStepDone>[0]>) =>
    filesStepDone({ readyCount: 1, processingCount: 0, extractionRunning: false, topicCount: 0, ...over })
  assert.equal(done({}), true)
  assert.equal(done({ readyCount: 0 }), false)
  assert.equal(done({ processingCount: 1 }), false)
  assert.equal(done({ processingCount: 1, extractionRunning: true }), true)
  assert.equal(done({ processingCount: 1, topicCount: 3 }), true)
})
