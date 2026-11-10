import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultUnit } from './default-unit'

const item = (unitId: string | null, over: { done?: boolean; topicId?: string | null } = {}) => ({ unitId, topicId: 't', done: false, ...over })
const day = (isToday: boolean, items: ReturnType<typeof item>[]) => ({ isToday, items })
const plan = (...days: ReturnType<typeof day>[]) => ({ days }) as never

test('the unit of the first thing left to do today', () => {
  assert.equal(defaultUnit(plan(day(true, [item('u1', { done: true }), item('u2')]), day(false, [item('u3')])), ['u1', 'u2', 'u3']), 'u2')
})

test('mocks and units the map cannot show are skipped, and no plan means the first unit', () => {
  assert.equal(defaultUnit(plan(day(true, [item('u1', { topicId: null }), item('gone'), item(null)])), ['u2', null]), null)
  assert.equal(defaultUnit(null, ['u2', 'u3']), 'u2')
  assert.equal(defaultUnit(plan(day(true, [])), ['u2', 'u3']), 'u2')
  assert.equal(defaultUnit(null, []), null)
})
