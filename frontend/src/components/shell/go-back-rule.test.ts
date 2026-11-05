import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canGoBackInApp } from './go-back-rule'

test('no earlier entry: no Go back', () => {
  assert.equal(canGoBackInApp(1, 'https://app.test/home', 'https://app.test', true), false)
})

test('after an in-app navigation, or from a same-site referrer: Go back', () => {
  assert.equal(canGoBackInApp(3, '', 'https://app.test', true), true)
  assert.equal(canGoBackInApp(2, 'https://app.test/courses/1', 'https://app.test', false), true)
})

test('another site or no referrer: no Go back', () => {
  assert.equal(canGoBackInApp(2, 'https://elsewhere.test/', 'https://app.test', false), false)
  assert.equal(canGoBackInApp(2, '', 'https://app.test', false), false)
})
