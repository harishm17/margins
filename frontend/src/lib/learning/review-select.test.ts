import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rating } from 'ts-fsrs'
import { type BandInputs } from './level'
import {
  closingRetests,
  nextMode,
  selectReviewItems,
  type BankItem,
  type DueConcept,
} from './review-select'

const NOW = new Date('2026-11-10T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

/** The band inputs of a concept known only by its ability and the rung of its last answer. */
function bandOf(ability: number, lastMaxRung: number | null, over: Partial<BandInputs> = {}): BandInputs {
  return {
    abilityInputs: { groupScores: [{ score: ability, at: daysAgo(3) }], retrievability: 1 },
    prior: null,
    lastMaxRung,
    latestIsIdk: false,
    consecutiveFails: 0,
    latestGrade: lastMaxRung === 0 ? Rating.Good : null,
    ...over,
  }
}

function due(conceptId: string, over: Partial<DueConcept> = {}): DueConcept {
  const mastery = over.mastery ?? 0.5
  const lastMaxRung = over.lastMaxRung ?? null
  return {
    conceptId,
    topicId: 't1',
    misconception: false,
    dueAt: daysAgo(1),
    retrievability: 0.8,
    mastery,
    lastMaxRung,
    bandInputs: bandOf(mastery, lastMaxRung),
    modeReached: 'recall',
    ...over,
  }
}

function item(itemKey: string, conceptIds: string[], over: Partial<BankItem> = {}): BankItem {
  return {
    itemKey,
    conceptIds,
    difficulty: 'medium',
    mode: 'recall',
    topicId: 't1',
    lastAnsweredAt: null,
    ...over,
  }
}

const select = (dueList: DueConcept[], bank: BankItem[], max = 12) =>
  selectReviewItems({ due: dueList, bank, now: NOW, max, timeZone: 'UTC' })

test('misconception first then most overdue then lowest R', () => {
  const dueList = [
    due('low-r', { dueAt: daysAgo(2), retrievability: 0.3, topicId: 'ta' }),
    due('overdue', { dueAt: daysAgo(5), retrievability: 0.8, topicId: 'tb' }),
    due('misc', { dueAt: daysAgo(1), retrievability: 0.85, misconception: true, topicId: 'tc' }),
    due('low-r2', { dueAt: daysAgo(2), retrievability: 0.6, topicId: 'td' }),
  ]
  const bank = dueList.map((d) => item(`i-${d.conceptId}`, [d.conceptId], { topicId: d.topicId }))
  const { items } = select(dueList, bank)
  assert.deepEqual(
    items.map((i) => i.itemKey),
    ['i-misc', 'i-overdue', 'i-low-r', 'i-low-r2']
  )
})

test('no two adjacent items on one concept', () => {
  const dueList = [due('a', { topicId: 'ta' }), due('b', { topicId: 'tb' }), due('c', { topicId: 'tc' })]
  // The best item for a also covers b, and the best item for c also covers b.
  const bank = [
    item('ab', ['a', 'b'], { topicId: 'ta' }),
    item('b2', ['b'], { topicId: 'tb' }),
    item('bc', ['b', 'c'], { topicId: 'tc' }),
    item('c2', ['c'], { topicId: 'tc' }),
  ]
  const { items } = select(dueList, bank)
  for (let i = 1; i < items.length; i++) {
    const shared = items[i].conceptIds.filter((c) => items[i - 1].conceptIds.includes(c))
    assert.deepEqual(shared, [], `${items[i - 1].itemKey} then ${items[i].itemKey}`)
  }
  assert.ok(items.length >= 2)
})

test('difficulty matches mastery band', () => {
  const bank = (['easy', 'medium', 'hard'] as const).map((d) => item(`x-${d}`, ['a'], { difficulty: d }))
  const pick = (mastery: number) => select([due('a', { mastery })], bank).items[0].difficulty
  assert.equal(pick(0.2), 'easy')
  assert.equal(pick(0.39), 'easy')
  assert.equal(pick(0.4), 'medium')
  assert.equal(pick(0.74), 'medium')
  assert.equal(pick(0.75), 'hard')
})

test('mode advances recall to discrimination to composition and drops back on failure', () => {
  assert.equal(nextMode('recall', { mode: 'recall', correct: true }), 'discrimination')
  assert.equal(nextMode('discrimination', { mode: 'discrimination', correct: true }), 'composition')
  assert.equal(nextMode('composition', { mode: 'composition', correct: true }), 'composition')
  assert.equal(nextMode('composition', { mode: 'composition', correct: false }), 'discrimination')
  assert.equal(nextMode('discrimination', { mode: 'discrimination', correct: false }), 'recall')
  assert.equal(nextMode('recall', { mode: 'recall', correct: false }), 'recall')
  // A miss kind forces the mode it names.
  assert.equal(nextMode('composition', { mode: 'composition', correct: false, missKind: 'cue_miss' }), 'recall')
  assert.equal(
    nextMode('composition', { mode: 'composition', correct: false, missKind: 'discrimination' }),
    'discrimination'
  )
  // A success clears any stale label.
  assert.equal(nextMode('recall', { mode: 'recall', correct: true, missKind: 'cue_miss' }), 'discrimination')
})

test('closing retests cover every miss, rung 2 or more and surrender with fresh items only', () => {
  const answered = [
    { itemKey: 'miss', conceptIds: ['a'], correct: false, maxRung: 0 as const, surrendered: false, topicId: 't1' },
    { itemKey: 'help', conceptIds: ['b'], correct: true, maxRung: 2 as const, surrendered: false, topicId: 't1' },
    { itemKey: 'surr', conceptIds: ['c'], correct: true, maxRung: 5 as const, surrendered: true, topicId: 't1' },
    { itemKey: 'clean', conceptIds: ['d'], correct: true, maxRung: 1 as const, surrendered: false, topicId: 't1' },
    { itemKey: 'rung0', conceptIds: ['e'], correct: true, maxRung: 0 as const, surrendered: false, topicId: 't1' },
  ]
  const bank = [
    item('miss', ['a']),
    item('a-fresh', ['a']),
    item('help', ['b']),
    item('b-fresh', ['b']),
    item('surr', ['c']),
    item('c-fresh', ['c']),
    item('d-fresh', ['d']),
    item('clean', ['d']),
  ]
  const keys = closingRetests(answered, bank).items.map((i) => i.itemKey)
  assert.deepEqual(keys, ['a-fresh', 'b-fresh', 'c-fresh'])
})

test('reports concepts with no fresh item as missing grouped by topic, mode and difficulty', () => {
  const weak = { mastery: 0.2 }
  const dueList = [
    due('a', { topicId: 'ta', ...weak }),
    due('b', { topicId: 'ta', ...weak }),
    due('c', { topicId: 'tb', modeReached: 'composition', ...weak }),
    due('d', { topicId: 'tb', modeReached: 'composition', ...weak }),
    due('e', { topicId: 'tb', ...weak }),
  ]
  const bank = [
    item('have-e', ['e'], { topicId: 'tb', difficulty: 'easy' }),
    item('wrong-mode-a', ['a'], { mode: 'composition', topicId: 'ta' }),
  ]
  const { items, missing } = select(dueList, bank)
  assert.deepEqual(items.map((i) => i.itemKey), ['have-e'])
  const sorted = missing
    .map((m) => ({ ...m, conceptIds: [...m.conceptIds].sort() }))
    .sort((x, y) => (x.topicId + x.mode).localeCompare(y.topicId + y.mode))
  assert.deepEqual(sorted, [
    { topicId: 'ta', conceptIds: ['a', 'b'], mode: 'recall', difficulty: 'easy' },
    { topicId: 'tb', conceptIds: ['c', 'd'], mode: 'composition', difficulty: 'easy' },
  ])
})

test('an item answered on the same local day is never served; its concept goes to missing', () => {
  const sameDay = new Date('2026-11-10T03:00:00Z')
  const lateYesterday = new Date('2026-11-09T23:30:00Z')
  const bank = [
    item('today', ['a'], { lastAnsweredAt: sameDay }),
    item('other', ['b'], { lastAnsweredAt: lateYesterday }),
  ]
  const { items, missing } = select([due('a', { mastery: 0.9 }), due('b', { mastery: 0.9 })], bank)
  assert.deepEqual(items.map((i) => i.itemKey), ['other'])
  assert.ok(missing.some((m) => m.conceptIds.includes('a') && m.difficulty === 'hard'))
  // The student's zone decides the day: in Los Angeles 03:00Z is the evening of the 9th, not today.
  const la = selectReviewItems({
    due: [due('a', { mastery: 0.9 })],
    bank: [item('today', ['a'], { lastAnsweredAt: sameDay })],
    now: NOW,
    max: 12,
    timeZone: 'America/Los_Angeles',
  })
  assert.deepEqual(la.items.map((i) => i.itemKey), ['today'])
  // A different item for the same concept is served instead when there is one.
  const { items: alt } = select([due('a')], [item('today', ['a'], { lastAnsweredAt: sameDay }), item('fresh', ['a'])])
  assert.deepEqual(alt.map((i) => i.itemKey), ['fresh'])
})

test('slots that cannot be placed are deferred and adjacency stays intact', () => {
  const dueTwo = [due('a', { topicId: 'ta' }), due('c', { topicId: 'tb', dueAt: daysAgo(0.5) })]
  const bank = [item('ax', ['a', 'x'], { topicId: 'ta' }), item('cx', ['c', 'x'], { topicId: 'tb' })]
  const { items, deferred } = select(dueTwo, bank)
  assert.deepEqual(items.map((i) => i.itemKey), ['ax'])
  assert.deepEqual(deferred.map((i) => i.itemKey), ['cx'])
})

// Item keys carry random ids (a quiz set's id), so a tie broken by key falls differently on every new course.
// Bank order is the order the questions were written in, the same each time.
