import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  S_MIN,
  type Card,
  type Grade,
} from 'ts-fsrs'
import type { EventRow } from './evidence-types'
import { FIRE } from './fire'
import { localDateParts } from './study-plan-time'

// Concept memory: a pure replay of one concept's evidence events (spec §3.5).

// ts-fsrs 5.4.2 defaults to learning steps of 1 and 10 minutes, which a one-review-per-day
// schedule can never serve. Same-day repetition is handled by the session collapse instead.
export const FSRS_PARAMS = {
  request_retention: 0.9,
  enable_fuzz: false,
  maximum_interval: 365,
  enable_short_term: false,
  learning_steps: [] as [],
}

const scheduler = fsrs(generatorParameters(FSRS_PARAMS))

const DAY_MS = 24 * 60 * 60 * 1000
const Q_WINDOW = 5

export type ConceptMemoryState = {
  card: Card | null
  dueAt: Date | null
  stability: number | null
  lastReviewAt: Date | null
  nUnassisted: number
  nAssisted: number
  lastEvidenceAt: Date | null
  lastAssistedAt: Date | null
  inferredPrior: number | null
  misconception: string | null
  misconceptionAt: Date | null
  consecutiveFails: number
  level0Scores: { score: number; at: Date }[]
  firstEvidenceDay: string | null
  itemKeysSeen: string[]
  delayedNewSuccess: boolean
  // A level-0 recall, teach-back or model-graded short answer at 0.75 or more (judgment gate, §3.6).
  explainedWell: boolean
  modeReached: Mode
  lastMaxRung: number | null
  lastMissKind: string | null
  // The latest non-warm-up group graded Again, or the latest IDK (spec 18.5).
  lastFailAt: Date | null
  // The latest instruction event, or any level-3 event (spec 18.5).
  lastInstructionAt: Date | null
  // The latest IDK (an event with `metadata.idk`); a warm-up IDK is a pretest miss and is not counted.
  lastIdkAt: Date | null
  // The grade the latest level-0/1 group earned (the band model reads it, spec 18.6).
  latestGrade: Grade | null
}

export type Mode = 'recall' | 'discrimination' | 'composition'
const MODES: Mode[] = ['recall', 'discrimination', 'composition']

/**
 * Without a near-twin there is no discrimination mode: a rising concept skips to composition and a
 * falling one passes through to recall. Shared by the replay rule and review selection.
 */
export function withoutDiscrimination(mode: Mode, rising: boolean): Mode {
  return mode === 'discrimination' ? (rising ? 'composition' : 'recall') : mode
}

/**
 * The mode reached after one level-0 answer (spec §7.4); the replay and review selection's `nextMode`
 * share it. A success in the mode reached moves on one; a failure in a mode already reached drops to
 * the layer below the failed one; a failure in the first mode stays.
 */
export function advanceMode(
  modeReached: Mode,
  answered: { mode: Mode; correct: boolean },
  hasConfusable = true
): Mode {
  const at = MODES.indexOf(answered.mode)
  const reached = MODES.indexOf(modeReached)
  let next = reached
  if (answered.correct) {
    if (at >= reached) next = Math.min(at + 1, MODES.length - 1)
  } else if (at > 0 && at <= reached) {
    next = at - 1
  }
  return hasConfusable ? MODES[next] : withoutDiscrimination(MODES[next], answered.correct)
}

export type GradeGroup = {
  score: number
  confidence?: number | null
  allFirstTry: boolean
}

export function gradeFor(group: GradeGroup): Grade {
  const { score } = group
  const confidence = group.confidence ?? null
  let grade: Grade
  if (score < 0.5) grade = Rating.Again
  else if (score < 0.75) grade = Rating.Hard
  else if (score >= 0.9 && confidence !== null && confidence >= 0.9 && group.allFirstTry)
    grade = Rating.Easy
  else grade = Rating.Good
  if (confidence !== null && confidence <= 0.4 && score >= 0.75 && grade > Rating.Hard)
    grade = Rating.Hard
  return grade
}

export function emptyMemoryState(): ConceptMemoryState {
  return {
    card: null,
    dueAt: null,
    stability: null,
    lastReviewAt: null,
    nUnassisted: 0,
    nAssisted: 0,
    lastEvidenceAt: null,
    lastAssistedAt: null,
    inferredPrior: null,
    misconception: null,
    misconceptionAt: null,
    consecutiveFails: 0,
    level0Scores: [],
    firstEvidenceDay: null,
    itemKeysSeen: [],
    delayedNewSuccess: false,
    explainedWell: false,
    modeReached: 'recall',
    lastMaxRung: null,
    lastMissKind: null,
    lastFailAt: null,
    lastInstructionAt: null,
    lastIdkAt: null,
    latestGrade: null,
  }
}

function implicitWeight(event: EventRow): number {
  const w = event.metadata?.pathWeight
  const raw = typeof w === 'number' && Number.isFinite(w) ? w : event.weight
  return Math.min(1, Math.max(0, raw))
}

function withCard(state: ConceptMemoryState, card: Card): ConceptMemoryState {
  return { ...state, card, dueAt: card.due, stability: card.stability }
}

// Implicit events (FIRe stability moves, spec §3.7) are written unconditionally; the target's
// own state at this point decides whether they apply.
export function applyImplicit(
  state: ConceptMemoryState,
  event: EventRow,
  now: Date = event.createdAt
): ConceptMemoryState {
  const card = state.card
  if (!card) return state
  const w = implicitWeight(event)
  if (event.metadata?.direction === 'penalty') {
    const stability = Math.max(card.stability * (1 - FIRE.penaltyFactor * w), S_MIN)
    const tomorrow = new Date(now.getTime() + DAY_MS)
    const due = card.due.getTime() > tomorrow.getTime() ? tomorrow : card.due
    return withCard(state, { ...card, stability, due })
  }
  if (event.metadata?.direction !== 'credit' || state.consecutiveFails >= 1) return state
  const good = scheduler.next(card, now, Rating.Good).card.stability
  // Credit never lowers stability and never moves the due date earlier: it adds the interval the extra
  // stability earns to the date the card already has, so a date pulled forward (a penalty, a hint) stays pulled.
  const stability = Math.max(card.stability, card.stability + w * (good - card.stability))
  const gained = Math.max(0, scheduler.next_interval(stability, 0) - scheduler.next_interval(card.stability, 0))
  return withCard(state, { ...card, stability, due: new Date(card.due.getTime() + gained * DAY_MS) })
}

type Group = { events: EventRow[]; at: Date }
type Step = { at: Date; kind: 'group'; group: Group } | { at: Date; kind: 'event'; event: EventRow }

function weightedMean(values: { value: number; weight: number }[]): number | null {
  if (values.length === 0) return null
  const total = values.reduce((sum, v) => sum + v.weight, 0)
  if (total <= 0) return values.reduce((sum, v) => sum + v.value, 0) / values.length
  return values.reduce((sum, v) => sum + v.value * v.weight, 0) / total
}

// The FSRS grade one concept's events from one session earn; replay and the implicit-credit
// writer both use it, so they cannot disagree. The score is the weighted mean of every event, a
// level-1 event (a failed first try, spec 18.4) entering at score 0 with its own weight: a failure
// on a secondary concept (weight 0.25) moves that concept a little rather than to Again. Easy still
// needs every event to be a level-0 first-try success.
export function gradeEventGroup(events: EventRow[]) {
  const mean = weightedMean(events.map((e) => ({ value: e.assistance === 1 ? 0 : e.score, weight: e.weight })))!
  const confidence = weightedMean(
    events.filter((e) => e.confidence !== null).map((e) => ({ value: e.confidence!, weight: e.weight }))
  )
  const allFirstTry = events.every((e) => e.assistance === 0 && e.score >= 0.9)
  const grade = gradeFor({ score: mean, confidence, allFirstTry })
  return { mean, score: mean, confidence, grade }
}

function localDay(at: Date, timeZone: string): string {
  const { year, month, day } = localDateParts(at, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function metaString(event: EventRow, key: string): string | null {
  const value = event.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function eventItemKey(event: EventRow): string | null {
  return event.itemKey ?? metaString(event, 'itemKey')
}

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as string[]).includes(value)
}

// Fields read from event metadata and item keys: the solid rule, the judgment gate, and the
// review choice inputs (spec §3.6, §7.4). Assisted events are not level-0 successes, but they
// still make an item "seen".
function deriveFromEvents(sorted: EventRow[], timeZone: string): Partial<ConceptMemoryState> {
  let firstEvidenceDay: string | null = null
  const seen = new Set<string>()
  let delayedNewSuccess = false
  let explainedWell = false
  let modeReached: Mode = 'recall'
  let lastMaxRung: number | null = null
  let lastMissKind: string | null = null
  let lastInstructionAt: Date | null = null
  let lastIdkAt: Date | null = null

  for (const event of sorted) {
    if (event.source === 'implicit') continue
    // Any level-3 event, and every instruction event, is the idea being shown (spec 18.5). An instruction
    // event is only that: it is not the student's evidence, so nothing else below reads it.
    if (event.assistance === 3 || event.source === 'instruction') lastInstructionAt = event.createdAt
    if (event.source === 'instruction') continue
    if (event.metadata?.idk === true && event.source !== 'warmup') lastIdkAt = event.createdAt
    const day = localDay(event.createdAt, timeZone)
    const key = eventItemKey(event)
    const level0 = event.source !== 'warmup' && event.assistance === 0
    // The solid rule's clock starts with the first real evidence: a warm-up is a pretest, not learning.
    if (firstEvidenceDay === null && event.source !== 'warmup') firstEvidenceDay = day
    if (level0 && event.score >= 0.75) {
      if (firstEvidenceDay !== null && day > firstEvidenceDay && key !== null && !seen.has(key)) delayedNewSuccess = true
      if (
        event.source === 'recall' ||
        event.source === 'teach_back' ||
        (event.gradedBy === 'model' && event.metadata?.questionType === 'short_answer')
      )
        explainedWell = true
    }
    if (key !== null) seen.add(key)

    const rung = event.metadata?.maxRung
    if (typeof rung === 'number' && Number.isFinite(rung)) lastMaxRung = rung
    // Only a miss names a miss kind; a success clears it, even if the event carries a stale label.
    const miss = event.score < 0.75 ? metaString(event, 'missKind') : null
    if (miss) lastMissKind = miss
    else if (event.score >= 0.75) lastMissKind = null

    // modeReached is the mode served next (spec §7.4). A level-0 success in the mode reached moves it
    // on one; a failure in a mode already reached drops it to the layer below the failed one, because
    // the earlier layer was weaker than it looked. A failure in the first mode stays there.
    const mode = event.metadata?.mode
    if (level0 && isMode(mode)) {
      modeReached = advanceMode(modeReached, { mode, correct: event.score >= 0.75 })
    }
  }
  return {
    firstEvidenceDay,
    itemKeysSeen: [...seen],
    delayedNewSuccess,
    explainedWell,
    modeReached,
    lastMaxRung,
    lastMissKind,
    lastInstructionAt,
    lastIdkAt,
  }
}

/** Item keys in question order: `quiz:<set>:2` before `quiz:<set>:10`. */
const ITEM_ORDER = new Intl.Collator('en', { numeric: true })

export function replayConcept(
  events: EventRow[],
  opts: { timeZone: string; now: Date }
): ConceptMemoryState {
  // Answers given at one moment (a quiz submitted at once) are taken in question order, the same way every replay:
  // the first mix-up named in a session is the one kept.
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || ITEM_ORDER.compare(a.itemKey ?? '', b.itemKey ?? ''))
  let state = emptyMemoryState()
  const warmups: { value: number; weight: number }[] = []
  const groups = new Map<string, Group>()
  const steps: Step[] = []

  for (const event of sorted) {
    if (event.source === 'implicit') {
      steps.push({ at: event.createdAt, kind: 'event', event })
    } else if (event.source === 'instruction') {
      // Instruction moves no card, q or due date; replay reads it only for lastInstructionAt (deriveFromEvents).
      continue
    } else if (event.source === 'warmup') {
      warmups.push({ value: event.score, weight: event.weight })
    } else if (event.assistance >= 2) {
      steps.push({ at: event.createdAt, kind: 'event', event })
    } else {
      let group = groups.get(event.sessionKey)
      if (!group) {
        group = { events: [], at: event.createdAt }
        groups.set(event.sessionKey, group)
        steps.push({ at: event.createdAt, kind: 'group', group })
      }
      group.events.push(event)
      group.at = event.createdAt
    }
  }
  steps.sort((a, b) => a.at.getTime() - b.at.getTime())
  state.inferredPrior = weightedMean(warmups)
  state = { ...state, ...deriveFromEvents(sorted, opts.timeZone) }
  // The latest evidence of any kind from the student; implicit events are not their evidence.
  const own = sorted.filter((e) => e.source !== 'implicit' && e.source !== 'instruction')
  state.lastEvidenceAt = own.length > 0 ? own[own.length - 1].createdAt : null

  let card: Card | null = null
  let lastReviewDay: string | null = null

  for (const step of steps) {
    if (step.kind === 'event' && step.event.source === 'implicit') {
      state = applyImplicit({ ...state, card }, step.event, step.at)
      card = state.card
      continue
    }
    if (step.kind === 'event') {
      const event = step.event
      state.nAssisted += 1
      state.lastAssistedAt = event.createdAt
      if (event.assistance === 3 && card) {
        const tomorrow = new Date(event.createdAt.getTime() + DAY_MS)
        if (card.due.getTime() > tomorrow.getTime()) card = { ...card, due: tomorrow }
      }
      continue
    }

    const group = step.group
    const at = group.at
    const { mean, score, confidence, grade } = gradeEventGroup(group.events)

    // A group is unassisted when it holds a level-0 event; a group of failed first tries alone is not.
    if (group.events.some((e) => e.assistance === 0)) state.nUnassisted += 1
    state.level0Scores = [...state.level0Scores, { score, at }].slice(-Q_WINDOW)

    // A misconception comes from the grader's own labelling, or from a confident wrong answer.
    // A mix-up between two concepts (discrimination) that names its wrong idea sets it too: that is the
    // picked option's own text on a quiz (spec §5.7).
    const labelled = group.events.find(
      (e) =>
        e.metadata?.missKind === 'misconception' ||
        (e.metadata?.missKind === 'discrimination' && !!metaString(e, 'misconception'))
    )
    const careless = group.events.some((e) => e.metadata?.missKind === 'careless')
    let misconception: string | null = null
    if (labelled) {
      misconception =
        metaString(labelled, 'misconception') ??
        `Confident but wrong on ${metaString(labelled, 'itemKey') ?? 'this item'}`
    } else if (!careless && confidence !== null && confidence >= 0.75 && mean < 0.5) {
      const withText = group.events.find((e) => metaString(e, 'misconception'))
      misconception = withText
        ? metaString(withText, 'misconception')
        : `Confident but wrong on ${metaString(group.events[0], 'itemKey') ?? 'this item'}`
    }
    if (misconception) {
      state.misconception = misconception
      state.misconceptionAt = at
    } else if (grade >= Rating.Good) {
      state.misconception = null
      state.misconceptionAt = null
    }

    state.latestGrade = grade
    if (grade === Rating.Again) {
      state.consecutiveFails += 1
      if (!state.lastFailAt || at > state.lastFailAt) state.lastFailAt = at
    } else state.consecutiveFails = 0

    // One FSRS review per concept per local day; later groups that day move the mastery inputs only.
    const day = localDay(at, opts.timeZone)
    if (day !== lastReviewDay) {
      lastReviewDay = day
      card = scheduler.next(card ?? createEmptyCard(at), at, grade).card
      state.lastReviewAt = at
    }
  }

  // A failure is an Again group or an IDK, whichever is later (spec 18.5).
  if (state.lastIdkAt && (!state.lastFailAt || state.lastIdkAt > state.lastFailAt)) state.lastFailAt = state.lastIdkAt

  state.card = card
  state.dueAt = card ? card.due : null
  state.stability = card ? card.stability : null
  return state
}
