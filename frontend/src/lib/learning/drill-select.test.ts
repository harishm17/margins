import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectDrillItems } from './drill-select'
import { Rating } from 'ts-fsrs'
import type { BankItem, DueConcept, Mode } from './review-select'

const NOW = new Date('2026-11-10T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function concept(conceptId: string, over: Partial<DueConcept> = {}): DueConcept {
  return {
    conceptId,
    topicId: 't1',
    misconception: false,
    dueAt: new Date(NOW.getTime() - DAY),
    retrievability: 0.6,
    mastery: 0.5,
    lastMaxRung: null,
    bandInputs: {
      abilityInputs: { groupScores: [{ score: over.mastery ?? 0.5, at: new Date(NOW.getTime() - 3 * DAY) }], retrievability: 1 },
      prior: null,
      lastMaxRung: over.lastMaxRung ?? null,
      latestIsIdk: false,
      consecutiveFails: 0,
      latestGrade: over.lastMaxRung === 0 ? Rating.Good : null,
    },
    modeReached: 'recall',
    ...over,
  }
}

function item(itemKey: string, conceptIds: string[], over: Partial<BankItem> = {}): BankItem {
  return { itemKey, conceptIds, difficulty: 'medium', mode: 'recall', topicId: 't1', lastAnsweredAt: null, ...over }
}

const bankFor = (conceptId: string, modes: Mode[], topicId = 't1') =>
  modes.map((mode, n) => item(`${conceptId}-${mode}-${n}`, [conceptId], { mode, topicId }))

const drill = (over: Partial<Parameters<typeof selectDrillItems>[0]> = {}) =>
  selectDrillItems({ concept: concept('c1'), prerequisite: null, bank: [], served: [], now: NOW, timeZone: 'UTC', ...over })

test('concept drill includes weak prerequisite', () => {
  const bank = [...bankFor('c1', ['recall', 'recall', 'composition', 'composition']), ...bankFor('p1', ['recall'], 't0')]
  const { items, missing } = drill({ concept: concept('c1'), prerequisite: concept('p1', { topicId: 't0', retrievability: 0.5 }), bank })
  assert.equal(items.length, 5)
  // The prerequisite comes first, as the idea this one stands on.
  assert.deepEqual(items[0].conceptIds, ['p1'])
  assert.equal(items.filter((i) => i.conceptIds.includes('p1')).length, 1)
  assert.deepEqual(missing, [])
})

test('a misconception with a near-twin starts with discrimination', () => {
  const bank = bankFor('c1', ['recall', 'discrimination', 'discrimination', 'composition', 'recall'])
  const { items } = drill({ concept: concept('c1', { misconception: true, confusableId: 'c2', modeReached: 'discrimination' }), bank })
  assert.equal(items[0].mode, 'discrimination')
  assert.deepEqual(items.map((i) => i.mode), ['discrimination', 'recall', 'discrimination', 'composition'])
})

test('a concept with no near-twin never gets a discrimination item', () => {
  const bank = bankFor('c1', ['recall', 'recall', 'discrimination', 'composition', 'composition'])
  const { items, missing } = drill({ bank })
  assert.ok(items.every((i) => i.mode !== 'discrimination'))
  assert.deepEqual(missing, [])
})

test('modes with no item in the bank are asked for, grouped by topic, mode and difficulty', () => {
  const bank = bankFor('c1', ['recall'])
  const { items, missing } = drill({ concept: concept('c1', { confusableId: 'c2', mastery: 0.2 }), bank })
  assert.equal(items.length, 1)
  assert.deepEqual(
    missing.map((m) => [m.mode, m.difficulty, m.conceptIds]),
    [
      ['discrimination', 'easy', ['c1']],
      ['composition', 'medium', ['c1']],
      ['discrimination', 'medium', ['c1']],
    ]
  )
})

test('an item answered today is not served, and served items are not served twice', () => {
  const bank = [
    item('seen-today', ['c1'], { lastAnsweredAt: new Date(NOW.getTime() - 60_000) }),
    item('served', ['c1']),
    item('fresh', ['c1']),
  ]
  const { items } = drill({ bank, served: [bank[1]] })
  assert.deepEqual(items.map((i) => i.itemKey), ['fresh'])
})
