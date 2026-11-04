// The server draft of a topic's worked examples (spec §18.7, surface worked_example): the predictions the student has written
// and what they did with each hidden part (opened it, graded it). One draft holds every example of the topic.
// No database or React imports.

import type { DraftPayloads } from './draft-contract'
import { validateDraftPayload } from './draft-contract'

export type WorkedExampleDraft = DraftPayloads['worked_example']
export type WorkedExampleItem = WorkedExampleDraft['items'][string]

/** The scope key `<topicId>:examples`. */
export const workedExampleKey = (topicId: string) => `${topicId}:examples`

/** A short stable name for an example's title, so a regenerated set does not inherit another example's work. */
export function exampleSig(title: string): string {
  return title.trim().replace(/\s+/g, ' ').slice(0, 40)
}

/** Whether the item holds anything the student did: a written prediction, or a part they opened. */
export function itemHasWork(item: Pick<WorkedExampleItem, 'drafts' | 'done'>): boolean {
  return Object.values(item.drafts).some((text) => text.trim() !== '') || Object.keys(item.done).length > 0
}

/** The draft to store for these items (the ones with work in them), or null when there is nothing to keep. */
export function toWorkedExampleDraft(items: Record<number, WorkedExampleItem>): WorkedExampleDraft | null {
  const kept = Object.entries(items).filter(([, item]) => itemHasWork(item))
  return kept.length === 0 ? null : { items: Object.fromEntries(kept) }
}

export function parseWorkedExampleDraft(raw: unknown): WorkedExampleDraft | null {
  const checked = validateDraftPayload('worked_example', raw)
  if (!checked.ok) return null
  const draft = checked.payload as WorkedExampleDraft
  return Object.keys(draft.items).length > 0 ? draft : null
}

/** The saved work for the example at `index` with this title, or undefined when there is none or the set has changed. */
export function savedItem(draft: WorkedExampleDraft | null, index: number, title: string): WorkedExampleItem | undefined {
  const item = draft?.items[String(index)]
  return item && item.sig === exampleSig(title) ? item : undefined
}
