import test from 'node:test'
import assert from 'node:assert/strict'
import { SPRINT_MAX_QUESTIONS, SPRINT_QUESTIONS_PER_TOPIC, SPRINT_TOPICS, sprintSizeLine } from './sprint-size'

test('the lobby says the size the sprint is built with', () => {
  assert.equal(sprintSizeLine(), 'Up to 12 questions from your 3 weakest topics, about 12 minutes.')
  // The cap is what the topics can supply at most, so the line never promises more than the builder can serve.
  assert.ok(SPRINT_MAX_QUESTIONS <= SPRINT_TOPICS * SPRINT_QUESTIONS_PER_TOPIC)
})
