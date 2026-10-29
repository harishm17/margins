import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSetup } from './course-setup'
import { healthReadiness } from './project-health'

const base = {
  status: 'active',
  materialCount: 0,
  topicCount: 2,
  confirmedTopicCount: 2,
  extractedTopicCount: 2,
  confirmedExtractedTopicCount: 2,
  contentBlockCount: 6,
  extraction: 'done',
} as const

test('a studied course whose files were all deleted is not blocked on materials', () => {
  const setup = deriveSetup(base)
  assert.ok(setup.step === null)
  const materialsMissing = setup.step === 1
  const result = healthReadiness({ materialsMissing, listConfirmed: true, contentReady: true, voiceReady: true })
  assert.equal(result.readiness, 'ready')
  assert.deepEqual(result.blockers, [])
})

test('a course with no files and nothing written needs materials', () => {
  const setup = deriveSetup({ ...base, contentBlockCount: 0 })
  const materialsMissing = setup.step === 1
  assert.equal(materialsMissing, true)
  const result = healthReadiness({ materialsMissing, listConfirmed: true, contentReady: false, voiceReady: false })
  assert.equal(result.readiness, 'needs_materials')
  assert.ok(result.blockers.includes('No validated materials'))
})

test('readiness steps: topics to confirm, then in progress', () => {
  const ok = { materialsMissing: false, contentReady: true, voiceReady: true }
  assert.equal(healthReadiness({ ...ok, listConfirmed: false }).readiness, 'needs_topic_confirmation')
  assert.equal(healthReadiness({ ...ok, listConfirmed: true, contentReady: false }).readiness, 'in_progress')
})
