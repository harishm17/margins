import { activityHref, type ActivityKind } from '@/lib/learning/next-activity'
import { parseView, type PathView, type ViewId } from './types'

/**
 * The words and places of the next activity (spec §8.1). The reason sentence comes with the activity
 * from `nextActivity`; this adds the button verb and the view an activity opens on. The destination
 * table is `activityHref`, defined beside the cascade and re-exported here for the screens.
 */
export { activityHref }

export const ACTIVITY_KINDS: ActivityKind[] = [
  'start',
  'instruct',
  'fix_misconception',
  'warmup',
  'read',
  'recall',
  'explainer',
  'examples',
  'review',
  'prerequisite_drill',
  'done_for_now',
  'quiz',
  'practice',
  'teach_back',
  'transfer_quiz',
  'mock_exam',
]

const VERBS: Record<ActivityKind, string> = {
  start: 'Open the topic',
  instruct: 'Read about it',
  examples: 'See an example',
  done_for_now: 'Try a harder set',
  fix_misconception: 'Start the drill',
  warmup: 'Start warm-up',
  read: 'Start reading',
  recall: 'Start recall',
  explainer: 'Open the explainer',
  review: 'Review',
  prerequisite_drill: 'Start the drill',
  quiz: 'Take quiz',
  practice: 'Practice',
  teach_back: 'Explain it',
  transfer_quiz: 'Take a harder quiz',
  mock_exam: 'Create a mock exam',
}

/** The button label for an activity. */
export const activityVerb = (kind: ActivityKind): string => VERBS[kind]

/**
 * The view of this topic a bare topic address opens on. Most activities are a view of the topic; a drill, a
 * review or a mock exam is its own page, so the topic opens on Practice and the next-activity card offers it.
 */
export function defaultViewFor(kind: ActivityKind): ViewId {
  switch (kind) {
    case 'warmup':
    case 'read':
    case 'recall':
    case 'explainer':
    case 'examples':
    case 'quiz':
    case 'practice':
      return kind
    case 'start':
      // A topic nobody has opened has no warm-up yet: bareTopicRedirect sends it to the preparation screen, and this is where it falls back to.
      return 'read'
    case 'instruct':
      // The explainer or the reader, at the concept: the address says which (`activityHref`); the bare view is the reader.
      return 'read'
    case 'teach_back':
      return 'recall'
    case 'transfer_quiz':
      return 'quiz'
    default:
      return 'practice'
  }
}

/** The path step an activity belongs to, or null when it sits outside the path (a tool, a drill, a review, an exam). */
export function pathStepFor(kind: ActivityKind): PathView | null {
  switch (kind) {
    case 'warmup':
    case 'read':
    case 'recall':
    case 'quiz':
    case 'practice':
      return kind
    case 'teach_back':
      return 'recall'
    case 'transfer_quiz':
      return 'quiz'
    default:
      return null
  }
}

/**
 * Whether the next activity's address is what the student is looking at now: the same page, the same view and
 * the same activity parameters (a harder quiz is not the plain quiz; a teach-back is not plain recall; the reader
 * pointed at a concept is not the plain reader).
 */
export function opensHere(nextHref: string, pathname: string, search: URLSearchParams): boolean {
  const url = new URL(nextHref, 'http://margins.local')
  const view = parseView(url.searchParams.get('view'))
  if (url.pathname !== pathname || view === null || view !== parseView(search.get('view'))) return false
  return ['difficulty', 'mode', 'focus'].every((key) => (url.searchParams.get(key) ?? null) === (search.get(key) ?? null))
}

/** The ?view= of a request path like "/courses/c/topics/t?view=read&x=1" (the x-pathname header), or null when it names none. */
export function viewInPath(path: string | null): string | null {
  const at = path?.indexOf('?') ?? -1
  return path && at >= 0 ? new URLSearchParams(path.slice(at + 1)).get('view') : null
}

/**
 * Where a bare topic address (no valid ?view=) goes, or null when the address already names a view. A next activity
 * that is a view of the topic is taken as its own address; the others leave the topic on Practice. "Solid for now"
 * is a card on the topic whose button opens the harder set: the topic itself stays on Practice.
 */
export function bareTopicRedirect(base: string, requestedView: unknown, next: { kind: ActivityKind; href: string }, preparingEntry = false): string | null {
  if (parseView(requestedView)) return null
  // A topic nobody has started is still being prepared: it opens on the preparation screen, not on the reader. `entry=1`
  // marks that address; the screen moves on by itself (to the warm-up) once the topic is ready.
  if (preparingEntry) return `${base}?view=read&entry=1`
  return next.kind !== 'done_for_now' && next.href.startsWith(`${base}?`) ? next.href : `${base}?view=${defaultViewFor(next.kind)}`
}
