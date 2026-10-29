import test from 'node:test'
import assert from 'node:assert/strict'
import { paletteFilter, paletteItem } from './palette-search'

const a = { id: 'file:1', label: 'notes.pdf', hint: 'CS 161', keywords: ['CS 161'] }
const b = { id: 'file:2', label: 'notes.pdf', hint: 'CS 161', keywords: ['CS 161'] }

test('two entries with the same label and hint get different values, Recent copies too', () => {
  assert.notEqual(paletteItem(a).value, paletteItem(b).value)
  assert.notEqual(paletteItem(a, 'recent:').value, paletteItem(b, 'recent:').value)
  assert.notEqual(paletteItem(a).value, paletteItem(a, 'recent:').value)
})

test('matching uses the visible label, hint and keywords, not the id', () => {
  const item = paletteItem({ id: 'file:9f3c2d', label: 'bayes-theorem.pdf', hint: 'STAT 110', keywords: ['STAT 110'] })
  const score = (search: string) => paletteFilter(item.value, search, item.keywords)
  assert.ok(score('bayes') > 0)
  assert.ok(score('stat') > 0)
  assert.equal(score('9f3c2d'), 0)
  assert.equal(score('zzz'), 0)
})
