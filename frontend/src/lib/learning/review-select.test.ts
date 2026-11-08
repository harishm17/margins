import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rating } from 'ts-fsrs'
import { conceptBand, type BandInputs } from './level'
import {
  closingRetests,
  nextMode,
  selectReviewItems,
  sessionShape,
  toMissKind,
  toRung,
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

test('at most three in a row from one topic', () => {
  const dueList = [
    ...['a1', 'a2', 'a3', 'a4', 'a5'].map((c, i) => due(c, { topicId: 'ta', dueAt: daysAgo(10 - i) })),
    ...['b1', 'b2'].map((c) => due(c, { topicId: 'tb', dueAt: daysAgo(1) })),
  ]
  const bank = dueList.map((d) => item(`i-${d.conceptId}`, [d.conceptId], { topicId: d.topicId }))
  const { items } = select(dueList, bank)
  assert.equal(items.length, 7)
  let run = 1
  for (let i = 1; i < items.length; i++) {
    run = items[i].topicId === items[i - 1].topicId ? run + 1 : 1
    assert.ok(run <= 3, `run of ${run} ending at ${i}`)
  }
})

test('a single-topic session still fills; only the concept rule is kept', () => {
  const dueList = ['a1', 'a2', 'a3', 'a4', 'a5'].map((c) => due(c))
  const bank = dueList.map((d) => item(`i-${d.conceptId}`, [d.conceptId]))
  assert.equal(select(dueList, bank).items.length, 5)
})

test('prefers items unseen for 7 days', () => {
  const bank = [
    item('seen', ['a'], { lastAnsweredAt: daysAgo(2) }),
    item('old', ['a'], { lastAnsweredAt: daysAgo(9) }),
    item('never', ['a'], { lastAnsweredAt: null }),
  ]
  const first = select([due('a')], bank).items[0]
  assert.ok(['old', 'never'].includes(first.itemKey))
  assert.equal(select([due('a')], [bank[0]]).items[0].itemKey, 'seen')
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

test('last problem needing rung 3 or more steps difficulty down one band', () => {
  const bank = (['easy', 'medium', 'hard'] as const).map((d) => item(`x-${d}`, ['a'], { difficulty: d }))
  const pick = (mastery: number, lastMaxRung: 0 | 1 | 2 | 3 | 4 | 5 | null) =>
    select([due('a', { mastery, lastMaxRung })], bank).items[0].difficulty
  assert.equal(pick(0.8, 3), 'medium')
  assert.equal(pick(0.5, 5), 'easy')
  assert.equal(pick(0.2, 4), 'easy')
  // Rung 2 is not enough to step down; no help at all steps up.
  assert.equal(pick(0.8, 2), 'hard')
  assert.equal(pick(0.5, 0), 'hard')
  assert.equal(pick(0.2, 0), 'medium')
})

test('targetBand delegates to conceptBand', () => {
  const bank = (['easy', 'medium', 'hard'] as const).map((d) => item(`x-${d}`, ['a'], { difficulty: d }))
  const pick = (concept: DueConcept) => select([concept], bank).items[0].difficulty
  // The stored mastery says stretch; the band inputs (ability, an IDK, the rung) decide.
  assert.equal(pick(due('a', { mastery: 0.95, bandInputs: bandOf(0.2, null) })), 'easy')
  assert.equal(pick(due('a', { mastery: 0.1, bandInputs: bandOf(0.9, null) })), 'hard')
  assert.equal(pick(due('a', { bandInputs: bandOf(0.9, null, { latestIsIdk: true }) })), 'medium')
  assert.equal(pick(due('a', { bandInputs: bandOf(0.5, null, { consecutiveFails: 1 }) })), 'easy')
  // A concept with no group scores yet takes the warm-up prior, else starts with support.
  const noEvidence = (prior: number | null) => ({ ...bandOf(0, null), abilityInputs: { groupScores: [], retrievability: 0 }, prior })
  assert.equal(pick(due('a', { bandInputs: noEvidence(null) })), 'easy')
  assert.equal(pick(due('a', { bandInputs: noEvidence(0.5) })), 'medium')
  // And the band is exactly conceptBand's.
  for (const concept of [bandOf(0.3, null), bandOf(0.6, 3), bandOf(0.8, 0), bandOf(0.8, 1, { latestGrade: Rating.Good })]) {
    assert.equal(pick(due('a', { bandInputs: concept })), (['easy', 'medium', 'hard'] as const)[conceptBand(concept)])
  }
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

test('no discrimination mode without a confusable', () => {
  assert.equal(nextMode('recall', { mode: 'recall', correct: true }, false), 'composition')
  assert.equal(nextMode('composition', { mode: 'composition', correct: false }, false), 'recall')
  const bank = [
    item('rec', ['a'], { mode: 'recall' }),
    item('dis', ['a'], { mode: 'discrimination' }),
    item('com', ['a'], { mode: 'composition' }),
  ]
  const pick = (d: Partial<DueConcept>) => select([due('a', d)], bank).items[0].mode
  assert.equal(pick({ modeReached: 'discrimination', confusableId: 'b' }), 'discrimination')
  assert.equal(pick({ modeReached: 'discrimination' }), 'composition')
  assert.equal(pick({ modeReached: 'discrimination', lastMissKind: 'misconception' }), 'recall')
  assert.equal(pick({ modeReached: 'composition' }), 'composition')
  assert.equal(pick({ modeReached: 'recall' }), 'recall')
})

test('a cue miss serves recall and a discrimination miss serves discrimination', () => {
  const bank = (['recall', 'discrimination', 'composition'] as const).map((m) => item(m, ['a'], { mode: m }))
  const pick = (d: Partial<DueConcept>) => select([due('a', d)], bank).items[0].mode
  assert.equal(pick({ modeReached: 'composition', lastMissKind: 'cue_miss' }), 'recall')
  assert.equal(pick({ modeReached: 'composition', lastMissKind: 'discrimination', confusableId: 'b' }), 'discrimination')
})

test('nextMode agrees with the replay rule in memory.ts', async () => {
  const { replayConcept } = await import('./memory')
  const modes = ['recall', 'discrimination', 'composition'] as const
  const mk = (mode: string, score: number, i: number) => ({
    id: `e${i}`, userId: 'u', projectId: 'p', topicId: 't', conceptId: 'a', source: 'quiz', sessionKey: `s${i}`,
    itemKey: `k${i}`, score, weight: 1, assistance: 0, confidence: null, gradedBy: 'rule', metadata: { mode },
    createdAt: new Date(Date.UTC(2026, 10, 1 + i)),
  })
  for (const first of modes) for (const second of modes) for (const ok1 of [true, false]) for (const ok2 of [true, false]) {
    const events = [mk(first, ok1 ? 1 : 0.2, 0), mk(second, ok2 ? 1 : 0.2, 1)]
    const replayed = replayConcept(events as never, { timeZone: 'UTC', now: new Date('2026-12-01T00:00:00Z') }).modeReached
    const stepped = nextMode(nextMode('recall', { mode: first, correct: ok1 }), { mode: second, correct: ok2 })
    assert.equal(stepped, replayed, `${first}/${ok1} then ${second}/${ok2}`)
  }
})

test('opening is easy and on the weakest concepts', () => {
  const items = [
    item('hard-weak', ['w'], { difficulty: 'hard', topicId: 'ta' }),
    item('med', ['m'], { difficulty: 'medium', topicId: 'tb' }),
    item('easy-strong', ['s'], { difficulty: 'easy', topicId: 'tc' }),
    item('easy-weak', ['w2'], { difficulty: 'easy', topicId: 'td' }),
    item('easy-mid', ['m2'], { difficulty: 'easy', topicId: 'te' }),
  ]
  const mastery = { w: 0.1, m: 0.4, s: 0.9, w2: 0.2, m2: 0.5 }
  const { opening, body, deferred } = sessionShape(items, mastery)
  assert.deepEqual(deferred, [])
  assert.deepEqual(opening.map((i) => i.itemKey), ['easy-weak', 'easy-mid'])
  assert.ok(opening.every((i) => i.difficulty === 'easy'))
  assert.equal(opening.length + body.length, items.length)
  assert.ok(!body.some((i) => opening.includes(i)))
  // No easy item: no opening.
  assert.deepEqual(sessionShape([item('m', ['m'])], mastery).opening, [])
  // The join keeps the adjacency rule.
  const joined = [...opening, ...body]
  for (let i = 1; i < joined.length; i++)
    assert.deepEqual(joined[i].conceptIds.filter((c) => joined[i - 1].conceptIds.includes(c)), [])
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

test('closing retests dedupe by itemKey and treat a surrendered item as needing a fresh form', () => {
  // The surrender evidence and the later finish event share one itemKey.
  const answered = [
    { itemKey: 'p1', conceptIds: ['a'], correct: true, maxRung: 5 as const, surrendered: true, topicId: 't1' },
    { itemKey: 'p1', conceptIds: ['a'], correct: true, maxRung: 0 as const, surrendered: false, topicId: 't1' },
    { itemKey: 'p2', conceptIds: ['b'], correct: true, maxRung: 0 as const, surrendered: false, topicId: 't1' },
    { itemKey: 'p2', conceptIds: ['b'], correct: true, maxRung: 0 as const, surrendered: false, topicId: 't1' },
  ]
  const bank = [item('p1', ['a']), item('a1', ['a']), item('a2', ['a']), item('p2', ['b']), item('b1', ['b'])]
  const out = closingRetests(answered, bank).items.map((i) => i.itemKey)
  assert.equal(out.length, 1)
  assert.ok(out[0] === 'a1' || out[0] === 'a2')
})

test('closing retests: one item covers several missed concepts, and no fresh item yields none', () => {
  const answered = [
    { itemKey: 'x', conceptIds: ['a', 'b'], correct: false, maxRung: 0 as const, surrendered: false, topicId: 't1' },
    { itemKey: 'y', conceptIds: ['z'], correct: false, maxRung: 0 as const, surrendered: false, topicId: 't1' },
  ]
  const bank = [item('x', ['a', 'b']), item('ab', ['a', 'b']), item('y', ['z'])]
  assert.deepEqual(closingRetests(answered, bank).items.map((i) => i.itemKey), ['ab'])
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

test('open warm: weakest concepts with no easy item are reported missing as easy', () => {
  const dueList = [
    due('weak', { mastery: 0.5, topicId: 'ta' }),
    due('weaker', { mastery: 0.1, topicId: 'tb' }),
    due('strong', { mastery: 0.9, topicId: 'tc' }),
    due('strong2', { mastery: 0.95, topicId: 'td' }),
  ]
  const bank = [
    item('i-weak', ['weak'], { topicId: 'ta', difficulty: 'medium' }),
    item('i-weaker', ['weaker'], { topicId: 'tb', difficulty: 'medium' }),
    item('i-strong', ['strong'], { topicId: 'tc', difficulty: 'hard' }),
    item('i-strong2', ['strong2'], { topicId: 'td', difficulty: 'hard' }),
  ]
  const { items, missing } = select(dueList, bank)
  assert.equal(items.length, 4)
  const sorted = missing.sort((x, y) => x.topicId.localeCompare(y.topicId))
  assert.deepEqual(sorted, [
    { topicId: 'ta', conceptIds: ['weak'], mode: 'recall', difficulty: 'easy' },
    { topicId: 'tb', conceptIds: ['weaker'], mode: 'recall', difficulty: 'easy' },
  ])
  // With an easy item for each weak concept nothing is missing.
  const withEasy = [
    ...bank,
    item('e-weak', ['weak'], { difficulty: 'easy' }),
    item('e-weaker', ['weaker'], { difficulty: 'easy' }),
  ]
  assert.deepEqual(select(dueList, withEasy).missing, [])
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

test('overdue compares local days, so lower R breaks ties within a day', () => {
  const dueList = [
    due('later-low-r', { dueAt: new Date('2026-11-09T20:00:00Z'), retrievability: 0.2, topicId: 'ta' }),
    due('earlier-high-r', { dueAt: new Date('2026-11-09T08:00:00Z'), retrievability: 0.85, topicId: 'tb' }),
    due('older', { dueAt: new Date('2026-11-08T23:00:00Z'), retrievability: 0.89, topicId: 'tc' }),
  ]
  const bank = dueList.map((d) => item(`i-${d.conceptId}`, [d.conceptId], { topicId: d.topicId }))
  assert.deepEqual(select(dueList, bank).items.map((i) => i.itemKey), ['i-older', 'i-later-low-r', 'i-earlier-high-r'])
})

test('a slot falls back to its next best item before it is deferred', () => {
  const dueList = [due('a', { topicId: 'ta' }), due('b', { topicId: 'tb', dueAt: daysAgo(0.5) })]
  // b's best item also covers a; its alternative does not, so b is served by that one.
  const bank = [
    item('a1', ['a'], { topicId: 'ta' }),
    item('ab', ['a', 'b'], { topicId: 'tb' }),
    item('b1', ['b'], { topicId: 'tb', difficulty: 'hard' }),
  ]
  const { items, deferred } = select(dueList, bank)
  assert.deepEqual(items.map((i) => i.itemKey), ['a1', 'b1'])
  assert.deepEqual(deferred, [])
})

test('slots that cannot be placed are deferred and adjacency stays intact', () => {
  const dueTwo = [due('a', { topicId: 'ta' }), due('c', { topicId: 'tb', dueAt: daysAgo(0.5) })]
  const bank = [item('ax', ['a', 'x'], { topicId: 'ta' }), item('cx', ['c', 'x'], { topicId: 'tb' })]
  const { items, deferred } = select(dueTwo, bank)
  assert.deepEqual(items.map((i) => i.itemKey), ['ax'])
  assert.deepEqual(deferred.map((i) => i.itemKey), ['cx'])
})

test('sessionShape places a priority list around shared concepts and defers what cannot be separated', () => {
  const ab = item('ab', ['a', 'b'], { topicId: 't1' })
  const bc = item('bc', ['b', 'c'], { topicId: 't2' })
  const d = item('d', ['d'], { topicId: 't3' })
  const shaped = sessionShape([ab, bc, d])
  assert.deepEqual(shaped.opening, [])
  assert.deepEqual(shaped.body.map((i) => i.itemKey), ['ab', 'd', 'bc'])
  assert.deepEqual(shaped.deferred, [])
  // An unseparable pair: one placed, one deferred, adjacency intact.
  const pair = sessionShape([item('a1', ['a']), item('a2', ['a'])])
  assert.deepEqual(pair.body.map((i) => i.itemKey), ['a1'])
  assert.deepEqual(pair.deferred.map((i) => i.itemKey), ['a2'])
  // Two easy items that cannot both open: nothing is lost and the joined order keeps the rule.
  const both = sessionShape([item('e1', ['a'], { difficulty: 'easy' }), item('e2', ['a'], { difficulty: 'easy' }), d])
  assert.equal(both.opening.length + both.body.length + both.deferred.length, 3)
  const seq = [...both.opening, ...both.body]
  for (let i = 1; i < seq.length; i++)
    assert.deepEqual(seq[i].conceptIds.filter((c) => seq[i - 1].conceptIds.includes(c)), [])
})

test('narrowing helpers turn stored memory fields into typed values', () => {
  assert.equal(toMissKind('cue_miss'), 'cue_miss')
  assert.equal(toMissKind('misconception'), 'misconception')
  assert.equal(toMissKind('bogus'), undefined)
  assert.equal(toMissKind(null), undefined)
  assert.equal(toMissKind(undefined), undefined)
  assert.equal(toMissKind(''), undefined)
  assert.equal(toRung(0), 0)
  assert.equal(toRung(5), 5)
  assert.equal(toRung(6), null)
  assert.equal(toRung(-1), null)
  assert.equal(toRung(2.5), null)
  assert.equal(toRung(Number.NaN), null)
  assert.equal(toRung(null), null)
})

test('closing retests report concepts with no fresh item as missing, grouped', () => {
  const base = { correct: false, maxRung: 0 as const, surrendered: false }
  const answered = [
    { ...base, itemKey: 'x', conceptIds: ['a'], topicId: 'ta', mode: 'composition' as const, difficulty: 'hard' as const },
    { ...base, itemKey: 'y', conceptIds: ['b'], topicId: 'ta', mode: 'composition' as const, difficulty: 'hard' as const },
    { ...base, itemKey: 'z', conceptIds: ['c'], topicId: 'tb' },
    { ...base, itemKey: 'w', conceptIds: ['d'], topicId: 'tb' },
  ]
  const bank = [item('x', ['a']), item('y', ['b']), item('w', ['d']), item('d2', ['d'])]
  const { items, missing } = closingRetests(answered, bank)
  assert.deepEqual(items.map((i) => i.itemKey), ['d2'])
  assert.deepEqual(missing, [
    { topicId: 'ta', conceptIds: ['a', 'b'], mode: 'composition', difficulty: 'hard' },
    { topicId: 'tb', conceptIds: ['c'], mode: 'recall', difficulty: 'medium' },
  ])
  // An item answered today is not a fresh form.
  const sameDay = [item('x', ['a']), item('a-today', ['a'], { lastAnsweredAt: new Date('2026-11-10T01:00:00Z') })]
  const today = closingRetests([answered[0]], sameDay, { now: NOW, timeZone: 'UTC' })
  assert.deepEqual(today.items, [])
  assert.equal(today.missing.length, 1)
})

test('caps at max', () => {
  const dueList = Array.from({ length: 20 }, (_, i) => due(`c${i}`, { topicId: `t${i % 5}` }))
  const bank = dueList.map((d) => item(`i-${d.conceptId}`, [d.conceptId], { topicId: d.topicId }))
  assert.equal(select(dueList, bank, 12).items.length, 12)
  assert.equal(select(dueList, bank, 3).items.length, 3)
  assert.equal(select(dueList, bank, 0).items.length, 0)
})

// Item keys carry random ids (a quiz set's id), so a tie broken by key falls differently on every new course.
// Bank order is the order the questions were written in, the same each time.
test('two items that tie for a concept are taken in bank order, not by their keys', () => {
  const bank = [item('quiz:f0:0', ['a']), item('quiz:0a:0', ['a'])]
  assert.deepEqual(
    select([due('a')], bank).items.map((i) => i.itemKey),
    ['quiz:f0:0']
  )
})

test('two fresh items that tie for a closing retest are taken in bank order, not by their keys', () => {
  const answered = [{ itemKey: 'miss', conceptIds: ['a'], correct: false, maxRung: 0 as const, surrendered: false, topicId: 't1' }]
  const bank = [item('miss', ['a']), item('quiz:f0:1', ['a']), item('quiz:0a:1', ['a'])]
  assert.deepEqual(
    closingRetests(answered, bank).items.map((i) => i.itemKey),
    ['quiz:f0:1']
  )
})
