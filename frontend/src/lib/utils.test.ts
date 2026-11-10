import test from 'node:test'
import assert from 'node:assert/strict'
import { cn } from './utils'

test('cn keeps a custom text size and a text colour together', () => {
  assert.equal(cn('text-small text-fg'), 'text-small text-fg')
  assert.equal(cn('text-fg-2 text-title'), 'text-fg-2 text-title')
})

test('cn lets a later custom text size replace an earlier one', () => {
  assert.equal(cn('text-small', 'text-title'), 'text-title')
})
