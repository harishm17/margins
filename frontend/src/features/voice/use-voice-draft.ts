'use client'

/**
 * What a reload takes away from a voice practice, kept in this tab so it can be given back.
 *
 * A reload ends the server session (so a paid session is never left open), and the transcript, the question and anything typed
 * but not sent lived only in memory. The snapshot written here is what the lobby offers to pick up again: "Continue" starts a new
 * session on the same scope, asks the last question again and puts the typed words back; "Start fresh" throws it away.
 * A snapshot older than 30 minutes is ignored: by then the student has moved on.
 */
import * as React from 'react'
import type { StartConfig } from './voice-controller'
import type { TranscriptEntry } from './session-state'

export const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000
const THROTTLE_MS = 300
const MAX_ENTRIES = 40
const MAX_TEXT = 2000

/** A transcript line as kept: just who said what, and how. */
export type SnapshotEntry = { role: 'student' | 'coach'; text: string; via?: 'voice' | 'text' }

export type VoiceSnapshot = {
  v: 1
  courseId: string
  /** The topic id, or `sprint` for a practice that spans the course. */
  scope: string
  mode: 'topic' | 'sprint'
  config: StartConfig
  savedAt: number
  /** This session's lines so far. */
  entries: SnapshotEntry[]
  /** The lines of an interrupted session this one was continued from, shown read-only above the new ones. */
  restored: SnapshotEntry[]
  /** The question the coach was on, in words. */
  question: string | null
  /** Typed but not sent. */
  draft: string
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const keyOf = (courseId: string, scope: string) => `margins-voice:${courseId}:${scope}`
// The typed-but-unsent words live under a key of their own: they change on every keystroke and must survive even when the snapshot
// of the transcript has not been written yet.
const draftKeyOf = (courseId: string, scope: string) => `margins-voice-draft:${courseId}:${scope}`

function storage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** The scope the open session writes under, set by `useVoiceSession`; `useVoiceDraft` follows it unless given one. */
let activeScope = 'sprint'
export const setActiveVoiceScope = (scope: string) => {
  activeScope = scope
}

const isEntry = (value: unknown): value is SnapshotEntry => {
  const entry = value as SnapshotEntry | null
  return !!entry && (entry.role === 'student' || entry.role === 'coach') && typeof entry.text === 'string'
}

/** Parse what storage holds; anything that is not a current snapshot of this scope is null. */
export function parseSnapshot(raw: string | null, courseId: string, scope: string, now: number): VoiceSnapshot | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as Partial<VoiceSnapshot> | null
    if (!data || data.v !== 1 || data.courseId !== courseId || data.scope !== scope) return null
    if (typeof data.savedAt !== 'number' || now - data.savedAt > SNAPSHOT_MAX_AGE_MS || now < data.savedAt - 60_000) return null
    if (!data.config || typeof data.config.style !== 'string' || typeof data.config.language !== 'string') return null
    return {
      v: 1,
      courseId,
      scope,
      mode: data.mode === 'topic' ? 'topic' : 'sprint',
      config: data.config,
      savedAt: data.savedAt,
      entries: Array.isArray(data.entries) ? data.entries.filter(isEntry) : [],
      restored: Array.isArray(data.restored) ? data.restored.filter(isEntry) : [],
      question: typeof data.question === 'string' ? data.question : null,
      draft: typeof data.draft === 'string' ? data.draft : '',
    }
  } catch {
    return null
  }
}

/** The words typed and not sent, when they are recent enough to matter. */
export function readVoiceDraft(courseId: string, scope: string, store: StorageLike | null = storage(), now = Date.now()): string {
  if (!store) return ''
  try {
    const held = JSON.parse(store.getItem(draftKeyOf(courseId, scope)) ?? 'null') as { text?: unknown; at?: unknown } | null
    return held && typeof held.text === 'string' && typeof held.at === 'number' && now - held.at <= SNAPSHOT_MAX_AGE_MS ? held.text : ''
  } catch {
    return ''
  }
}

export function writeVoiceDraft(courseId: string, scope: string, text: string, store: StorageLike | null = storage(), now = Date.now()) {
  try {
    if (text) store?.setItem(draftKeyOf(courseId, scope), JSON.stringify({ text, at: now }))
    else store?.removeItem(draftKeyOf(courseId, scope))
  } catch {
    // Storage can be full or blocked; the words are still in the box.
  }
}

export function readVoiceSnapshot(courseId: string, scope: string, store: StorageLike | null = storage(), now = Date.now()): VoiceSnapshot | null {
  if (!store) return null
  let raw: string | null = null
  try {
    raw = store.getItem(keyOf(courseId, scope))
  } catch {
    return null
  }
  const snapshot = parseSnapshot(raw, courseId, scope, now)
  if (raw && !snapshot) {
    try {
      store.removeItem(keyOf(courseId, scope))
    } catch {
      // Nothing to clear if storage is blocked.
    }
  }
  return snapshot ? { ...snapshot, draft: readVoiceDraft(courseId, scope, store, now) } : null
}

export function writeVoiceSnapshot(snapshot: VoiceSnapshot, store: StorageLike | null = storage()) {
  try {
    // The draft is kept under its own key (see draftKeyOf).
    store?.setItem(keyOf(snapshot.courseId, snapshot.scope), JSON.stringify({ ...snapshot, draft: '' }))
  } catch {
    // Storage can be full or blocked; the practice itself is not affected.
  }
}

/** Forget the snapshot and the typed words: the practice ended on purpose, or the student chose to start fresh. */
export function clearVoiceSnapshot(courseId: string, scope: string, store: StorageLike | null = storage()) {
  try {
    store?.removeItem(keyOf(courseId, scope))
    store?.removeItem(draftKeyOf(courseId, scope))
  } catch {
    // Nothing to clear if storage is blocked.
  }
}

/** The transcript as kept: capped, trimmed, with the quiet app lines and empty replies left out. */
export function snapshotEntries(entries: readonly TranscriptEntry[]): SnapshotEntry[] {
  const kept: SnapshotEntry[] = []
  for (const entry of entries) {
    if (entry.role === 'coach' && entry.note) continue
    const text = entry.text.trim().slice(0, MAX_TEXT)
    if (!text) continue
    kept.push(entry.role === 'student' ? { role: 'student', text, via: entry.via } : { role: 'coach', text })
  }
  return kept.slice(-MAX_ENTRIES)
}

/** What the lobby card says about an interrupted practice. */
export function describeSnapshot(snapshot: VoiceSnapshot): { lastCoach: string | null; lastStudent: string | null; draft: string; answers: number } {
  const all = [...snapshot.restored, ...snapshot.entries]
  const last = (role: SnapshotEntry['role']) => [...all].reverse().find((entry) => entry.role === role)?.text ?? null
  return {
    lastCoach: snapshot.question ?? last('coach'),
    lastStudent: last('student'),
    draft: snapshot.draft,
    answers: all.filter((entry) => entry.role === 'student').length,
  }
}

/**
 * The words the new session opens with when it continues an interrupted one. The coach has no memory of the old session, so it is
 * told in the student's voice what happened and which question to ask again before going on.
 */
export function resumeOpening(snapshot: VoiceSnapshot): string | null {
  const { lastCoach } = describeSnapshot(snapshot)
  if (!lastCoach) return null
  const question = lastCoach.replace(/\s+/g, ' ').trim().slice(0, 400)
  return `I reloaded the page and lost my place. Please ask me this question again before moving on: ${question}`
}

/**
 * Prepare a continued session: the old lines move to `restored` (shown read-only), this session's own lines start empty, and the
 * unsent draft stays for the typing box to pick up.
 */
export function startResume(snapshot: VoiceSnapshot, store: StorageLike | null = storage()) {
  writeVoiceSnapshot({ ...snapshot, restored: [...snapshot.restored, ...snapshot.entries].slice(-MAX_ENTRIES), entries: [], savedAt: Date.now() }, store)
}

/** Write the open session's state, keeping what a continued session carries (`restored`, the typed `draft`). */
export function persistLiveSession(
  base: Pick<VoiceSnapshot, 'courseId' | 'scope' | 'mode' | 'config'>,
  live: { entries: readonly TranscriptEntry[]; question: string | null },
  store: StorageLike | null = storage(),
  now = Date.now()
) {
  const held = readVoiceSnapshot(base.courseId, base.scope, store, now)
  writeVoiceSnapshot(
    {
      v: 1,
      ...base,
      savedAt: now,
      entries: snapshotEntries(live.entries),
      restored: held?.restored ?? [],
      question: live.question,
      draft: '',
    },
    store
  )
}

/** Turn kept lines back into transcript entries (negative ids, so they never meet the live ones). */
export function toTranscript(entries: readonly SnapshotEntry[]): TranscriptEntry[] {
  return entries.map((entry, index): TranscriptEntry =>
    entry.role === 'student'
      ? { id: -(index + 1), role: 'student', text: entry.text, via: entry.via ?? 'text' }
      : { id: -(index + 1), role: 'coach', text: entry.text, streaming: false, interrupted: false }
  )
}

/**
 * The typing box of a voice practice and what a reload takes from it. `draft` is what is typed and not yet sent (back after a
 * continued session starts), `setDraft` keeps it as the student types, `clear` drops it after a send, and `restoredTranscript` is the
 * earlier session's lines to show read-only above the new ones.
 */
export function useVoiceDraft(courseId: string, scope?: string) {
  const key = scope ?? activeScope
  const [restoredTranscript] = React.useState<TranscriptEntry[]>(() => toTranscript(readVoiceSnapshot(courseId, key)?.restored ?? []))
  const [draft, setDraftState] = React.useState(() => readVoiceDraft(courseId, key))
  const draftRef = React.useRef(draft)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    writeVoiceDraft(courseId, key, draftRef.current)
  }, [courseId, key])

  const setDraft = React.useCallback(
    (next: string) => {
      draftRef.current = next
      setDraftState(next)
      if (!timer.current) timer.current = setTimeout(flush, THROTTLE_MS)
    },
    [flush]
  )
  const clear = React.useCallback(() => setDraft(''), [setDraft])

  React.useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  return { draft, setDraft, clear, restoredTranscript }
}
