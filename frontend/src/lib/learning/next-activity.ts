import type { ConceptLabel } from './concept-mastery'
import type { Band } from './level'
import { reviewSessionHref } from './review-links'
import { unitTopicIds } from './unit-topics'

/**
 * What a student should do next on one topic (spec §8.1). Pure: server/queries/topic.ts gathers the
 * state, this decides. The first rule that applies wins, so the order below is the order of the spec.
 *
 * Instruction comes before every retrieval (spec 18.5): a concept whose latest retrieval failed is sent to
 * the explanation or the pages before it is asked again, and an easier step comes before review. With the AI
 * down (spec 18.9) a rule whose activity needs the model is passed over, and the next rule's reason says so.
 */

export type ActivityKind =
  /** A topic nobody has opened yet: opening it starts its preparation, and the topic then names its first step. */
  | 'start'
  | 'instruct'
  | 'fix_misconception'
  | 'warmup'
  | 'read'
  | 'recall'
  | 'explainer'
  | 'examples'
  | 'review'
  | 'prerequisite_drill'
  | 'done_for_now'
  | 'quiz'
  | 'practice'
  | 'teach_back'
  | 'transfer_quiz'
  | 'mock_exam'

export type TopicConceptState = {
  id: string
  /** The concept's name, for the chips on the topic header. */
  name?: string
  /** Concept mastery now (lib/learning/concept-mastery.ts). */
  mastery: number
  /** The state in the words the map uses for the same idea (Solid, Shaky, ...). */
  label: ConceptLabel
  retrievability: number
  /** The live misconception, or null. */
  misconception: string | null
  consecutiveFails: number
  /** Groups with a level-0 event so far. */
  nUnassisted: number
  /** The concept has an FSRS card: some group was rated. Without one it is never "due". */
  hasCard: boolean
  /** At least one level-0 quiz event on this concept. */
  hasQuizEvidence: boolean
  prerequisiteIds: string[]
  /** The concept's support band (lib/learning/level.ts): 0 support, 1 core, 2 stretch. */
  band: Band
  /** Its latest retrieval failed and nothing has shown the idea since (`needsInstruction`, instruction.ts). */
  needsInstruction: boolean
  /** A worked example was delivered on it, or a drill held it, after its last fail. */
  easierStepSinceFail: boolean
  /** Its latest level-0 group today was graded Good or better. */
  latestGroupGoodToday: boolean
  /** When its latest retrieval failed (an Again group or an IDK), or null. */
  lastFailAt: Date | null
  /** Where the source first makes its first claim: the page and chunk a pointer opens, or null when it has no claim. */
  firstClaim: { page: number | null; chunkId: string | null } | null
  /** The prerequisite with the lowest mastery (any topic); the loader resolves it for concepts that keep failing. */
  weakestPrerequisiteId?: string | null
  /** That prerequisite has R under 0.8 or mastery under 0.4. */
  prerequisiteWeak: boolean
}

export type TopicLearningState = {
  /** The topic's active concepts. Empty for a topic whose extraction failed, has not run, or predates v3. */
  concepts: TopicConceptState[]
  /** Something has been prepared for the topic: concepts, a warm-up bank or any written content. False only for a topic nobody has opened yet. */
  prepared: boolean
  /** At least 80% of the practice steps are solved (the same share the path and the Topics list use for a finished Practice). */
  practiceDone: boolean
  /** Practice problems are written for the topic. Without them, opening Practice has to write them, which needs the model. */
  practiceWritten: boolean
  /** The warm-up bank exists. */
  warmupReady: boolean
  warmupAt: Date | null
  readAt: Date | null
  recallAt: Date | null
  /** A level-0 quiz at 0.8 or more (guesses counted wrong) moved the path on: read and recall are skipped (spec 18.6). */
  testedOutAt: Date | null
  /** The student chose a quick pass for this topic (spec 18.8): read and recall are skipped. */
  triage: 'quick' | null
  /** Concepts with a missing or incorrect claim in the latest recall attempt. */
  recallGaps: string[]
  /** The concepts whose gap explainer is already written (so it can be opened with the AI down). */
  gapExplainerReadyFor: string[]
  /** When the student opened the explainer after that recall, or null. */
  explainerVisitedAt: Date | null
  lastTeachBackAt: Date | null
  /** Latest attempt on a quiz set whose questions are all hard. */
  lastHardQuizAt: Date | null
  /** A hard set already exists, so a harder quiz needs no model to start. */
  hardSetOnHand: boolean
  lastExamAt: Date | null
  /** The earliest date any of the topic's concepts falls due, for the "Solid for now" sentence. */
  nextReviewAt: Date | null
  /** Any evidence of any source on this topic, or (without concepts) a finished quiz. */
  hasAnyEvidence: boolean
}

/** Where an `instruct` activity opens: the gap explainer at the concept, or the reader at its first claim. */
export type InstructTarget = { conceptId: string; via: 'explainer' | 'reread'; chunkId: string | null }

export type NextActivity = { kind: ActivityKind; conceptIds: string[]; reason: string; target?: InstructTarget }

export type NextActivityContext = {
  /** Whether the AI can be used now (`getAiStatus`, cached 10 s). */
  ai: 'up' | 'down'
  now: Date
  /** The student's zone, for the date in "Solid for now". */
  timeZone: string
}

/** Retrievability under which a concept is due for review (the retention FSRS aims at). */
const DUE_BELOW = 0.9
const SOLID = 0.8
const FAILS_BEFORE_EASIER_STEP = 2
const STRETCH_EVIDENCE = 3

// The tie order of the stretch rotation (spec §8.1).
const STRETCH_ORDER = ['teach_back', 'transfer_quiz', 'mock_exam'] as const
type StretchKind = (typeof STRETCH_ORDER)[number]

/** The activities that need the model, and the sentence that says so when one is passed over (spec 18.9). */
const AI_DOWN_NOTE = {
  practice: 'Practice is not written yet and needs the AI, which is down. This works without it.',
  recall: 'Recall needs the AI, which is down. This works without it.',
  explainer: "The explainer isn't written yet and needs the AI, which is down. This works without it.",
  teach_back: 'Explaining it back needs the AI, which is down. This works without it.',
  transfer_quiz: 'A new harder quiz needs the AI, which is down. This works without it.',
  mock_exam: 'A mock exam needs the AI, which is down. This works without it.',
} as const

const byLowest = <T>(key: (item: T) => number) => (a: T, b: T) => key(a) - key(b)

const formatDay = (at: Date, timeZone: string): string => new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(at)

/** The stretch rotation's pick among the kinds `usable` allows: the one whose latest evidence is oldest. */
function stretchPick(s: TopicLearningState, usable: (kind: StretchKind) => boolean): StretchKind | null {
  const latest: Record<StretchKind, Date | null> = {
    teach_back: s.lastTeachBackAt,
    transfer_quiz: s.lastHardQuizAt,
    mock_exam: s.lastExamAt,
  }
  // Never done counts as the oldest. The strict comparison keeps the earlier kind on a tie.
  const time = (kind: StretchKind) => latest[kind]?.getTime() ?? -Infinity
  let pick: StretchKind | null = null
  for (const kind of STRETCH_ORDER) {
    if (usable(kind) && (pick === null || time(kind) < time(pick))) pick = kind
  }
  return pick
}

const STRETCH_REASONS: Record<StretchKind, string> = {
  teach_back: 'You know this well. Explain it in your own words to make it stick.',
  transfer_quiz: 'You know this well. A harder quiz checks that it holds up on new questions.',
  mock_exam: 'You know this well. A mock exam shows how it holds up with the rest of the unit.',
}

/** The reason an `instruct` activity gives: the concept and the page, or the explanation. */
function instructReason(concept: TopicConceptState, via: InstructTarget['via']): string {
  const name = concept.name ? concept.name : 'this'
  if (via === 'explainer') return `You missed ${name} last time. Read the explanation of just that part before trying again.`
  const page = concept.firstClaim?.page
  return page ? `You missed ${name} last time. Read p. ${page} again before trying again.` : `You missed ${name} last time. Read that part of the pages again before trying again.`
}

export function nextActivity(s: TopicLearningState, ctx: NextActivityContext): NextActivity {
  const aiUp = ctx.ai === 'up'
  // The first activity passed over because the AI is down names itself in the reason of the one taken instead.
  let note: string | null = null
  const passOver = (kind: keyof typeof AI_DOWN_NOTE) => {
    note ??= AI_DOWN_NOTE[kind]
  }
  const pick = (activity: NextActivity): NextActivity => (note ? { ...activity, reason: `${note} ${activity.reason}` } : activity)

  // Read and recall are passed over (both stay open in the path) for a topic the student tested out of
  // with a strong quiz, and for a quick pass (spec 18.6, 18.8).
  const skipsReadAndRecall = s.testedOutAt !== null || s.triage === 'quick'

  // Practice comes before the first quiz on the path. It is left for the quiz when the student chose a quick pass, when it is
  // done, and when it would have to be written with the AI down (then the quiz's reason says so).
  const practiceBeforeQuiz = !s.practiceDone && s.triage !== 'quick'
  const practiceFirst = practiceBeforeQuiz && (aiUp || s.practiceWritten)

  // A topic nobody has opened yet has no first step to name: its warm-up, concepts and reading are all made when it is
  // opened, and which of them comes first depends on what that makes. It goes to the topic itself, which names the step
  // once it is ready (the page and the path do), instead of to a step it may not start with.
  if (!s.prepared && !s.hasAnyEvidence && !s.readAt && !skipsReadAndRecall) {
    return { kind: 'start', conceptIds: [], reason: 'Margins gets this topic ready when you open it, then starts you on its first step.' }
  }

  // A topic without concepts keeps the old path, in the order the path shows it: Read, Practice, Quiz. Recall,
  // reviews and drills all need concepts. Practice comes before the first quiz; after it, practice keeps the topic fresh.
  if (s.concepts.length === 0) {
    if (!s.readAt && !skipsReadAndRecall) return { kind: 'read', conceptIds: [], reason: 'Read the topic next.' }
    if (!s.hasAnyEvidence) {
      if (practiceFirst) return { kind: 'practice', conceptIds: [], reason: 'Work through the practice, then take the quiz.' }
      if (practiceBeforeQuiz) passOver('practice')
      return pick({ kind: 'quiz', conceptIds: [], reason: 'Take the quiz to see what you know.' })
    }
    return { kind: 'practice', conceptIds: [], reason: 'Practice to keep it fresh.' }
  }

  // 1. Instruction: a concept whose latest retrieval failed, with nothing shown since. It goes to the gap explainer when a
  // ready one covers the concept, and otherwise to the reader at its first claim, which needs no AI. The most recent
  // fail leads.
  const needing = s.concepts.filter((c) => c.needsInstruction).sort((a, b) => (b.lastFailAt?.getTime() ?? 0) - (a.lastFailAt?.getTime() ?? 0))
  if (needing.length > 0) {
    const lead = needing[0]
    const via = s.gapExplainerReadyFor.includes(lead.id) ? 'explainer' : 'reread'
    return { kind: 'instruct', conceptIds: needing.map((c) => c.id), reason: instructReason(lead, via), target: { conceptId: lead.id, via, chunkId: lead.firstClaim?.chunkId ?? null } }
  }

  // 2. A live misconception, instructed since (an Again group sets it, so rule 1 caught it first).
  const wrong = s.concepts.filter((c) => c.misconception)
  if (wrong.length > 0) {
    return {
      kind: 'fix_misconception',
      conceptIds: wrong.map((c) => c.id),
      reason: 'A wrong idea showed up in your answers. A short drill sorts it out.',
    }
  }

  // 3. The warm-up, only while it is ready and the topic is not yet read (a pretest after reading measures nothing).
  if (!s.warmupAt && !s.hasAnyEvidence && s.warmupReady && !s.readAt) {
    return { kind: 'warmup', conceptIds: [], reason: 'Try a few questions before reading. It shows what to look for.' }
  }

  // 4 and 5. Read, then recall (which needs the model).
  if (!s.readAt && !skipsReadAndRecall) return { kind: 'read', conceptIds: [], reason: 'Read the topic next.' }
  if (!s.recallAt && !skipsReadAndRecall) {
    if (aiUp) return { kind: 'recall', conceptIds: [], reason: 'Close the book and say what you remember.' }
    passOver('recall')
  }

  // 6. Gaps found by recall that the explainer has not covered. It needs the model only while it is not yet written.
  if (s.recallGaps.length > 0 && !s.explainerVisitedAt) {
    const written = s.recallGaps.filter((id) => s.gapExplainerReadyFor.includes(id))
    if (aiUp) return pick({ kind: 'explainer', conceptIds: s.recallGaps, reason: 'Recall left gaps. The explainer covers just those.' })
    if (written.length > 0) return pick({ kind: 'explainer', conceptIds: written, reason: 'Recall left gaps. The explainer covers just those.' })
    passOver('explainer')
  }

  // 7. The easier step: a concept missed twice in a row (so an instruction came between the fails), with no easier step
  // since its last fail. A weak prerequisite is drilled; otherwise the worked examples at full support.
  const stuck = s.concepts.filter((c) => c.consecutiveFails >= FAILS_BEFORE_EASIER_STEP && !c.easierStepSinceFail).sort(byLowest((c) => c.mastery))
  if (stuck.length > 0) {
    const c = stuck[0]
    if (c.prerequisiteWeak && c.prerequisiteIds.length > 0) {
      return pick({
        kind: 'prerequisite_drill',
        // The drill targets the weakest prerequisite; the failing concept follows it.
        conceptIds: [c.weakestPrerequisiteId ?? c.prerequisiteIds[0], c.id],
        reason: 'You have missed this more than once. A drill on what it builds on may help.',
      })
    }
    return pick({ kind: 'examples', conceptIds: [c.id], reason: 'This has been hard twice. See one worked through, then try again.' })
  }

  // 8. Due for review: a card exists and retrievability has fallen under the retention target.
  const due = s.concepts.filter((c) => c.hasCard && c.retrievability < DUE_BELOW).sort(byLowest((c) => c.retrievability))
  if (due.length > 0) {
    return pick({ kind: 'review', conceptIds: due.map((c) => c.id), reason: 'Some of this is due for review before it fades.' })
  }

  // 9. Every concept had a level-0 group today graded Good or better, and none is due: solid for now.
  if (s.concepts.every((c) => c.latestGroupGoodToday)) {
    const when = s.nextReviewAt ? ` It comes back for review on ${formatDay(s.nextReviewAt, ctx.timeZone)}.` : ''
    return pick({ kind: 'done_for_now', conceptIds: [], reason: `Solid for now.${when}` })
  }

  // 10. Not yet solid: a quiz when there is no quiz evidence, practice otherwise.
  const open = s.concepts.filter((c) => c.mastery < SOLID).sort(byLowest((c) => c.mastery))
  const unquizzed = open.filter((c) => !c.hasQuizEvidence)
  // The path is Practice, then Quiz, so the first quiz waits for the practice. A quick pass goes straight to the quiz
  // (it skips the slow steps), and so does a topic whose practice is already worked through.
  if (unquizzed.length > 0 && practiceFirst) {
    return pick({ kind: 'practice', conceptIds: unquizzed.map((c) => c.id), reason: 'Work through the practice, then take the quiz.' })
  }
  if (unquizzed.length > 0) {
    if (practiceBeforeQuiz) passOver('practice')
    return pick({ kind: 'quiz', conceptIds: unquizzed.map((c) => c.id), reason: 'Take the quiz to see where you stand.' })
  }
  if (open.length > 0) {
    return pick({ kind: 'practice', conceptIds: open.map((c) => c.id), reason: 'Practice what is not solid yet.' })
  }

  // 11. Everything solid: the stretch rotation once each concept has enough unaided evidence. With the AI down it uses the
  // kinds that need no model (a harder set already on hand); if none is left, practice stands in.
  if (s.concepts.every((c) => c.nUnassisted >= STRETCH_EVIDENCE)) {
    const needsAi = (kind: StretchKind) => !(kind === 'transfer_quiz' && s.hardSetOnHand)
    const wanted = stretchPick(s, () => true)!
    if (!aiUp && needsAi(wanted)) passOver(wanted)
    const usable = stretchPick(s, (kind) => aiUp || !needsAi(kind))
    if (usable) return pick({ kind: usable, conceptIds: s.concepts.map((c) => c.id), reason: STRETCH_REASONS[usable] })
    return pick({ kind: 'practice', conceptIds: s.concepts.map((c) => c.id), reason: 'Solid so far. Practice keeps it fresh.' })
  }
  const thin = s.concepts.filter((c) => c.nUnassisted < STRETCH_EVIDENCE)
  return pick({ kind: 'practice', conceptIds: thin.map((c) => c.id), reason: 'Solid so far. A little more practice makes it certain.' })
}

/**
 * The next activity with its address, for a topic of a course. The topic page, the course overview, Home and the
 * plan all come through here, so they agree, mock exam address included (the unit's topics: see unit-topics.ts).
 */
export function activityWithHref(
  state: TopicLearningState,
  ctx: NextActivityContext & { courseId: string; topicId: string; topics: { id: string; unitId: string | null; confirmed: boolean }[]; listConfirmed: boolean }
): NextActivity & { href: string } {
  const next = nextActivity(state, { ai: ctx.ai, now: ctx.now, timeZone: ctx.timeZone })
  const href = activityHref(next.kind, {
    courseId: ctx.courseId,
    topicId: ctx.topicId,
    conceptIds: next.conceptIds,
    unitTopicIds: unitTopicIds(ctx.topics, ctx.topicId, ctx.listConfirmed),
    target: next.target,
  })
  return { ...next, href }
}

/** Where an activity opens. The in-topic views (warmup, read, recall, explainer) are rendered by the topic page. */
export type ActivityContext = {
  courseId: string
  topicId: string
  conceptIds: string[]
  /** The topics of this topic's unit, in course order (for the new-exam form). Defaults to this topic. */
  unitTopicIds?: string[]
  /** Where an `instruct` activity opens. */
  target?: InstructTarget
}

export function activityHref(kind: ActivityKind, ctx: ActivityContext): string {
  const base = `/courses/${ctx.courseId}/topics/${ctx.topicId}`
  switch (kind) {
    case 'start':
      // The bare topic address: the topic sends the student on to its first step (bareTopicRedirect).
      return base
    case 'fix_misconception':
    case 'prerequisite_drill':
      // A drill on one concept; the session adds its weakest prerequisite or confusable.
      return reviewSessionHref(ctx.courseId, { conceptId: ctx.conceptIds[0] ?? null, topicId: ctx.topicId })
    case 'review':
      return reviewSessionHref(ctx.courseId, { topicId: ctx.topicId })
    case 'instruct': {
      const target = ctx.target
      if (!target) return `${base}?view=read`
      const focus = encodeURIComponent(target.conceptId)
      if (target.via === 'explainer') return `${base}?view=explainer&focus=${focus}`
      return `${base}?view=read&focus=${focus}${target.chunkId ? `#chunk-${target.chunkId}` : ''}`
    }
    case 'examples':
      return `${base}?view=examples${ctx.conceptIds[0] ? `&focus=${encodeURIComponent(ctx.conceptIds[0])}` : ''}&fade=full`
    case 'transfer_quiz':
    case 'done_for_now':
      return `${base}?view=quiz&difficulty=hard`
    case 'mock_exam': {
      const topics = ctx.unitTopicIds && ctx.unitTopicIds.length > 0 ? ctx.unitTopicIds : [ctx.topicId]
      return `/courses/${ctx.courseId}/exams/new?topics=${topics.map(encodeURIComponent).join(',')}`
    }
    case 'teach_back':
      return `${base}?view=recall&mode=teach_back`
    case 'warmup':
    case 'read':
    case 'recall':
    case 'explainer':
    case 'quiz':
    case 'practice':
      return `${base}?view=${kind}`
  }
}
