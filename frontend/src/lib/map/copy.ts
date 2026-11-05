import type { ConceptLabel } from '@/lib/learning/concept-mastery'
import { IDEA_RECALL_WORDS } from '@/lib/learning/progress-words'
import { daysBetween, localDay } from '@/lib/learning/plan'
import type { PanelLinkKind } from '@/server/queries/map'

/** The words of the knowledge map (spec §9). Every state is words as well as an icon and a colour. */

/** The idea-recall words live in the one progress glossary (lib/learning/progress-words.ts), so the map and every idea list agree. */
export const LABEL_TEXT: Record<ConceptLabel, string> = IDEA_RECALL_WORDS

/** In the order a student moves through them, for the key under the map. */
export const LABEL_ORDER: ConceptLabel[] = ['not_started', 'inferred', 'shaky', 'getting_there', 'solid', 'fading']

export const FRONTIER_TEXT = 'Next up'
export const START_HERE_TEXT = 'Start here'

/**
 * The key's line for the next-up ring. Spec §9: the ring marks an idea whose prerequisites are all remembered at
 * R >= 0.8 (lib/map/frontier.ts), which is "well remembered", not "solid": a prerequisite answered well yesterday
 * can still be Shaky overall and counts.
 */
export function frontierKeyText(count: number): string {
  const line = `${FRONTIER_TEXT}: ready to study. You answered what it builds on well recently`
  return count > 1 ? `${line}. The ring marks ${START_HERE_TEXT}, the first of them.` : `${line}. The ring marks it.`
}

/** Under the key: the two measures a student could mix up, said once. */
export const KEY_TWO_MEASURES =
  'Two different things: Solid, Shaky and the other states say how well you know the idea overall. Next up and Start here say whether you are ready for it now.'

/** The names that occur more than once in the unit (compared without case), which need their topic named beside them. */
export function duplicateNames(nodes: readonly { name: string }[]): Set<string> {
  const seen = new Map<string, number>()
  for (const node of nodes) {
    const key = node.name.trim().toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return new Set([...seen].filter(([, count]) => count > 1).map(([key]) => key))
}

/** The question for a suggested link, from the side of the idea whose panel is open. */
export function edgeQuestionText(kind: PanelLinkKind, panelName: string, otherName: string): string {
  return {
    needs: `Does ${panelName} require ${otherName} first?`,
    needed_by: `Does ${otherName} require ${panelName} first?`,
    covers: `Does ${panelName} cover ${otherName}?`,
    covered_by: `Does ${otherName} cover ${panelName}?`,
    confusable: `Are ${panelName} and ${otherName} easy to mix up?`,
  }[kind]
}

/**
 * The words on each next-up idea, by id. When several are next up the first in list order says where to start and
 * the others stay "Next up"; a single one is just "Next up".
 */
export function frontierTexts(nodes: readonly { id: string; frontier: boolean }[]): Record<string, string> {
  const next = nodes.filter((node) => node.frontier)
  return Object.fromEntries(next.map((node, index) => [node.id, next.length > 1 && index === 0 ? START_HERE_TEXT : FRONTIER_TEXT]))
}

/** "Solid · next review in 6 days": the state, then when it is due. */
export function stateLine(label: ConceptLabel, dueAt: string | null, now: Date, timeZone: string): string {
  const state = LABEL_TEXT[label]
  if (!dueAt) return state
  const gap = daysBetween(localDay(now, timeZone), localDay(new Date(dueAt), timeZone))
  if (gap <= 0) return `${state} · review due`
  if (gap === 1) return `${state} · next review tomorrow`
  return `${state} · next review in ${gap} days`
}

const SOURCE_TEXT: Record<string, string> = {
  warmup: 'Warm-up',
  recall: 'Recall',
  quiz: 'Quiz',
  review: 'Review',
  exam: 'Mock exam',
  practice: 'Practice',
  example: 'Worked example',
  voice: 'Voice',
  teach_back: 'Explained it',
  ask_check: 'Ask',
  reader: 'Reading check',
  drill: 'Drill',
  implicit: 'Credit from a related idea',
}

/** "Quiz · 80%" or "Drill · 40% · with help". */
export function eventLine(event: { source: string; score: number; assisted: boolean }): string {
  const parts = [SOURCE_TEXT[event.source] ?? event.source, `${Math.round(event.score * 100)}%`]
  if (event.assisted) parts.push('with help')
  return parts.join(' · ')
}

/** The question or statement about a link, read from the panel concept's side. A suggested link ends in a question mark. */
export function linkText(kind: PanelLinkKind, otherName: string, suggested: boolean): string {
  const text = {
    needs: `Needs ${otherName}`,
    needed_by: `${otherName} needs this`,
    covers: `Covers ${otherName}`,
    covered_by: `${otherName} covers this`,
    confusable: `Easy to mix up with ${otherName}`,
  }[kind]
  return suggested ? `${text}?` : text
}
