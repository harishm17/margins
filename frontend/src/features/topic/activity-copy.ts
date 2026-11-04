import { activityHref, type ActivityKind } from '@/lib/learning/next-activity'
import { parseView, PATH_VIEWS, type PathView, type ViewId } from './types'

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
  start: 'Start warm-up',
  instruct: 'Read that part again',
  examples: 'See an example',
  done_for_now: 'Try a harder set',
  fix_misconception: 'Practise the gap',
  warmup: 'Start warm-up',
  read: 'Start reading',
  recall: 'Start recall',
  explainer: 'Open the explainer',
  review: 'Review',
  prerequisite_drill: 'Practise the basics',
  quiz: 'Take quiz',
  practice: 'Practice',
  teach_back: 'Explain it',
  transfer_quiz: 'Take a harder quiz',
  mock_exam: 'Create a mock exam',
}

/** The button label for an activity. */
export const activityVerb = (kind: ActivityKind): string => VERBS[kind]

/** Whether a read-again pointer opens the explanation of the student's gaps rather than the reading. */
const opensExplainer = (activity: { kind: ActivityKind; href: string }): boolean =>
  activity.kind === 'instruct' && parseView(new URL(activity.href, 'http://margins.local').searchParams.get('view')) === 'explainer'

/**
 * The button label for an activity with its address: "Read that part again" is the general word for a read-again pointer,
 * but one that opens the explanation says so ("Read the explanation of your gaps"). The student who is already on the explainer is not
 * shown it: `nextLineShows` leaves the line off the page it points to.
 */
export function activityLabel(activity: { kind: ActivityKind; href: string }): string {
  return opensExplainer(activity) ? 'Read the explanation of your gaps' : VERBS[activity.kind]
}

const TITLES: Record<ActivityKind, string> = {
  start: 'Warm-up',
  instruct: 'Read that part again',
  examples: 'Worked example',
  done_for_now: 'A harder set',
  fix_misconception: 'Practise the gap',
  warmup: 'Warm-up',
  read: 'Read',
  recall: 'Recall',
  explainer: 'Explanation of your gaps',
  review: 'Review',
  prerequisite_drill: 'Practise the basics',
  quiz: 'Quiz',
  practice: 'Practice',
  teach_back: 'Explain it back',
  transfer_quiz: 'Harder quiz',
  mock_exam: 'Mock exam',
}

/**
 * The short name of an activity as a title or a tag ("Recall", "Practise the gap", "Explanation of your gaps"), the noun
 * beside `activityLabel`'s verb. Home, the course overview, the Topics list and the topic page all name one activity with
 * this and `activityLabel`, so the same task never has two names.
 */
export function activityTitle(activity: { kind: ActivityKind; href?: string }): string {
  if (activity.href && opensExplainer({ kind: activity.kind, href: activity.href })) return 'Explanation of your gaps'
  return TITLES[activity.kind]
}

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

/** The step of the path an activity belongs to for the "Next" tag: a read-again pointer belongs to Read; one that opens the explainer belongs to none. */
function tagStepFor(next: { kind: ActivityKind; href: string }): PathView | null {
  const own = pathStepFor(next.kind)
  if (own || next.kind !== 'instruct') return own
  const view = parseView(new URL(next.href, 'http://margins.local').searchParams.get('view'))
  return view && (PATH_VIEWS as readonly string[]).includes(view) ? (view as PathView) : null
}

/**
 * The step of the path tagged "Next": the step the next activity belongs to while that step is not done, else the first
 * step that is not done, else none (every step done). It is the one place the path bar, the Topics list and the topic page
 * ask, so they never name different steps for one topic. The explainer of the student's gaps is a detour, not a step: while it
 * is the next activity the tag is on the first step not done (Practice after Recall), the step the detour leads back to, and
 * the button beside it says "Read the explanation of your gaps" with that step as the way on, so the tag and the button
 * never name two different next steps.
 */
export function nextPathStep(next: { kind: ActivityKind; href: string }, steps: readonly PathView[], done: Record<PathView, boolean>): PathView | null {
  const own = tagStepFor(next)
  if (own && steps.includes(own) && !done[own]) return own
  return steps.find((step) => !done[step]) ?? null
}

/**
 * Whether the "Next" line shows above the view that is open. There is one next signal on a topic: the tag in the path. The
 * line says more (the reason, the way in) only where the open view has no action of its own that leads on: on a tool
 * (Examples, Explainer), which is not a step. A step of the path always has its own (Check, "I've read it", Start quiz...),
 * so the line stays off it, and a read-again pointer therefore never repeats on every step. The exception is a next activity
 * that is no step at all (a drill, a review, a mock exam, "solid for now"): a bare topic address lands on Practice for it, so
 * that is the one step where the line says it, because nothing else on the page would.
 */
export function nextLineShows(next: { kind: ActivityKind; href: string }, view: string, steps: readonly PathView[], pointsHere = false): boolean {
  if (next.kind === 'start') return false
  // The line that points at the page the student is already on says "go where you are" (the explainer's own "Read the explanation").
  if (pointsHere) return false
  const onStep = (steps as readonly string[]).includes(view)
  if (!onStep) return true
  return tagStepFor(next) === null && defaultViewFor(next.kind) === view
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
