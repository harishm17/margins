/**
 * What the browser keeps for a recall card between keystrokes, page loads and a failed send (spec §5.3).
 *
 * A card is open from the moment its text box is shown. Its draft holds the student's text, so a 503 from the
 * grader leaves the answer to send again, and `abandoned`: the reader or the explainer was opened while the card
 * was open, so the answer is no longer given with the book closed and is sent as level 2. The draft lives in
 * sessionStorage and goes when the answer is graded.
 *
 * The text itself now lives on the server (`useServerDraft('recall', ...)`, spec 18.7), so it survives a closed tab and
 * another device. This file stays as a thin adapter: it keeps the open and abandoned marks, which belong to this tab,
 * and reads the text of a draft an older version left here.
 */

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export type Draft = { text: string; abandoned: boolean; voice: boolean; open: boolean }

const PREFIX = 'margins:recall:'

export const draftKey = (topicId: string, cardKey: string) => `${PREFIX}${topicId}:${cardKey}`

const EMPTY: Draft = { text: '', abandoned: false, voice: false, open: false }

/** A draft as stored (text), or the empty draft when there is none or it is damaged. */
export function parseDraft(raw: string | null): Draft {
  try {
    if (raw === null) return EMPTY
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return EMPTY
    const draft = value as Record<string, unknown>
    return {
      text: typeof draft.text === 'string' ? draft.text : '',
      abandoned: draft.abandoned === true,
      voice: draft.voice === true,
      open: true,
    }
  } catch {
    return EMPTY
  }
}

export function readDraft(storage: DraftStorage, topicId: string, cardKey: string): Draft {
  try {
    return parseDraft(storage.getItem(draftKey(topicId, cardKey)))
  } catch {
    return EMPTY
  }
}

function save(storage: DraftStorage, topicId: string, cardKey: string, draft: Omit<Draft, 'open'>) {
  try {
    storage.setItem(draftKey(topicId, cardKey), JSON.stringify(draft))
  } catch {
    // A full or blocked storage loses the safety net, not the page.
  }
}

/** The card's text box is shown: the card is open. Nothing changes if it already is. */
export function openDraft(storage: DraftStorage, topicId: string, cardKey: string) {
  const draft = readDraft(storage, topicId, cardKey)
  if (!draft.open) save(storage, topicId, cardKey, { text: '', abandoned: false, voice: false })
}

/** The student typed or dictated: keep the text. The abandoned mark stays as it is. */
export function writeText(storage: DraftStorage, topicId: string, cardKey: string, text: string, voice: boolean) {
  const draft = readDraft(storage, topicId, cardKey)
  save(storage, topicId, cardKey, { text, abandoned: draft.abandoned, voice: voice || draft.voice })
}

export function clearDraft(storage: DraftStorage, topicId: string, cardKey: string) {
  try {
    storage.removeItem(draftKey(topicId, cardKey))
  } catch {
    // ignore
  }
}

/** The reader or the explainer was opened: every card of the topic that is open can no longer count as level 0. Returns how many. */
export function markRecallAbandoned(storage: DraftStorage, topicId: string): number {
  const prefix = `${PREFIX}${topicId}:`
  let marked = 0
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (key && key.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) {
      const cardKey = key.slice(prefix.length)
      const draft = readDraft(storage, topicId, cardKey)
      save(storage, topicId, cardKey, { text: draft.text, abandoned: true, voice: draft.voice })
      marked += 1
    }
  } catch {
    // ignore
  }
  return marked
}

/** What the server draft of a recall card holds (spec 18.7). */
export type RecallDraftPayload = { text: string; voice: boolean }

/** A stored server draft as the card uses it, or null when it is not one. */
export function parseRecallPayload(raw: unknown): RecallDraftPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  return typeof value.text === 'string' ? { text: value.text, voice: value.voice === true } : null
}
