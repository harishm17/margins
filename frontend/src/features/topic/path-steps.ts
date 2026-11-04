import type { ActivityKind } from '@/lib/learning/next-activity'
import { pathStepFor } from './activity-copy'
import { PATH_VIEWS, VIEW_LABELS, type PathView } from './types'

/**
 * The steps of the path this topic can offer (Review Focus 2: no step that cannot work). Warm-up needs a
 * bank and a topic not read yet (or one already taken); Recall needs concepts, or concepts on the way. A topic from before concepts,
 * or whose extraction failed, is Read, Practice, Quiz. Every view still has its address.
 */
export function pathSteps(input: {
  hasConcepts: boolean
  warmupReady: boolean
  warmupDone: boolean
  /** The topic is read: a pretest after reading measures nothing new (spec §5.1). Left out, it counts as not read. */
  readDone?: boolean
  preparingConcepts: boolean
  /** A topic nobody has started is being prepared: the path keeps its five steps in place (Warm-up and Recall marked as preparing) instead of growing as the jobs finish. */
  preparingEntry?: boolean
}): PathView[] {
  return PATH_VIEWS.filter((step) => {
    if (step === 'warmup') return (input.warmupReady && !input.readDone) || input.warmupDone || !!input.preparingEntry
    if (step === 'recall') return input.hasConcepts || input.preparingConcepts || !!input.preparingEntry
    return true
  })
}

export type PathGlyphState = 'done' | 'next' | 'later'

/** One step of the path for a row of the Topics list: done, the one to do next, or still ahead. */
export type PathGlyph = { step: PathView; label: string; state: PathGlyphState }

/**
 * The path as the Topics list draws it: the steps this topic offers, each done, the next one (the step the topic's
 * next activity belongs to, the one the topic's own path tags), or later. It is built from the same inputs the
 * topic page uses, so a row and the topic it opens do not disagree.
 */
export function pathGlyphs(input: { steps: PathView[]; done: Record<PathView, boolean>; nextStep: PathView | null }): PathGlyph[] {
  return input.steps.map((step) => ({
    step,
    label: VIEW_LABELS[step],
    state: input.done[step] ? 'done' : input.nextStep === step ? 'next' : 'later',
  }))
}

const OUTSIDE_PATH_WORDS: Partial<Record<ActivityKind, string>> = {
  start: 'Warm-up',
  instruct: 'Read that part again',
  examples: 'Worked example',
  explainer: 'Explainer',
  review: 'Review',
  fix_misconception: 'Practise the gap',
  prerequisite_drill: 'Practise the basics',
  mock_exam: 'Mock exam',
}

/** What is next on a topic, in words (a screen reader hears it on the Topics list): "Next: Warm-up", "Solid for now". */
export function nextStepWords(kind: ActivityKind): string {
  if (kind === 'done_for_now') return 'Solid for now'
  if (kind === 'teach_back') return 'Next: Explain it back'
  if (kind === 'transfer_quiz') return 'Next: Harder quiz'
  const step = pathStepFor(kind)
  return `Next: ${step ? VIEW_LABELS[step] : (OUTSIDE_PATH_WORDS[kind] ?? 'Continue')}`
}
