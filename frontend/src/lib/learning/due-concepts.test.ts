import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueConcepts, surrenderedDue, type EvidenceFact, type MemorySummary } from './due-concepts'

const ZONE = 'America/Los_Angeles'
// Tuesday 2026-11-10, 14:00 in Los Angeles.
const NOW = new Date('2026-11-10T22:00:00Z')
const at = (iso: string) => new Date(iso)

function fact(over: Partial<EvidenceFact> = {}): EvidenceFact {
  return {
    conceptId: 'c1',
    itemKey: 'practice:content:0:1',
    createdAt: at('2026-11-09T20:00:00Z'),
    source: 'practice',
    assistance: 3,
    surrendered: true,
    ...over,
  }
}

function memory(over: Partial<MemorySummary> = {}): MemorySummary {
  return {
    conceptId: 'c1',
    topicId: 't1',
    hasCard: true,
    dueAt: at('2026-11-09T20:00:00Z'),
    retrievability: 0.8,
    mastery: 0.5,
    misconception: false,
    modeReached: 'recall',
    lastMaxRung: null,
    lastMissKind: null,
    bandInputs: {
      abilityInputs: { groupScores: [], retrievability: 0.8 },
      prior: null,
      lastMaxRung: null,
      latestIsIdk: false,
      consecutiveFails: 0,
      latestGrade: null,
    },
    ...over,
  }
}

const due = (memories: MemorySummary[], surrendered = new Map<string, Date>(), confusableOf: Record<string, string> = {}) =>
  dueConcepts({ memories, surrendered, confusableOf: (id) => confusableOf[id], now: NOW, timeZone: ZONE })

test('a step surrendered on an earlier day is due from the start of the next local day', () => {
  const result = surrenderedDue([fact()], NOW, ZONE)
  // Surrendered Monday 12:00 in Los Angeles: due from Tuesday 00:00 there, which is 08:00 UTC.
  assert.deepEqual([...result.keys()], ['c1'])
  assert.equal(result.get('c1')?.toISOString(), '2026-11-10T08:00:00.000Z')
})

test('the surrender and the later finish of the same step are one surrender, by item key', () => {
  const events = [
    fact({ createdAt: at('2026-11-08T20:00:00Z') }),
    // The finished step writes its own event with the same key and the surrendered flag.
    fact({ createdAt: at('2026-11-09T20:00:00Z'), assistance: 3 }),
  ]
  const result = surrenderedDue(events, NOW, ZONE)
  assert.equal(result.size, 1)
  // Due from the day after the first surrender, not pushed later by the finish event.
  assert.equal(result.get('c1')?.toISOString(), '2026-11-09T08:00:00.000Z')
})

test('a level-0 answer after the surrender settles it', () => {
  const events = [fact(), fact({ source: 'review', assistance: 0, surrendered: false, itemKey: 'quiz:b:1', createdAt: at('2026-11-10T10:00:00Z') })]
  assert.equal(surrenderedDue(events, NOW, ZONE).size, 0)
})

test('a level-0 answer before the surrender does not settle it, and a warm-up or implicit event never does', () => {
  const events = [
    fact({ source: 'quiz', assistance: 0, surrendered: false, itemKey: 'quiz:a:0', createdAt: at('2026-11-01T10:00:00Z') }),
    fact(),
    fact({ source: 'warmup', assistance: 0, surrendered: false, itemKey: 'quiz:w:0', createdAt: at('2026-11-10T10:00:00Z') }),
    fact({ source: 'implicit', assistance: 0, surrendered: false, itemKey: 'x', createdAt: at('2026-11-10T11:00:00Z') }),
  ]
  assert.equal(surrenderedDue(events, NOW, ZONE).size, 1)
})

test('concepts are due when their date is before the end of today or R is under 0.9', () => {
  const result = due([
    memory({ conceptId: 'late', dueAt: at('2026-11-08T00:00:00Z'), retrievability: 0.7 }),
    memory({ conceptId: 'today', dueAt: at('2026-11-11T05:00:00Z'), retrievability: 0.92 }),
    memory({ conceptId: 'tomorrow', dueAt: at('2026-11-12T00:00:00Z'), retrievability: 0.99 }),
    memory({ conceptId: 'fading', dueAt: at('2026-11-20T00:00:00Z'), retrievability: 0.85 }),
  ])
  assert.deepEqual(result.map((c) => c.conceptId).sort(), ['fading', 'late', 'today'])
})

test('a concept with no card is not due, unless a surrender brought it back', () => {
  const none = memory({ conceptId: 'new', hasCard: false, dueAt: null, retrievability: 0 })
  assert.equal(due([none]).length, 0)
  const back = due([none], new Map([['new', at('2026-11-10T08:00:00Z')]]))
  assert.equal(back.length, 1)
  assert.equal(back[0].dueAt.toISOString(), '2026-11-10T08:00:00.000Z')
})
