'use client'

/**
 * useServerDraft: the one way a writing surface keeps what the student is typing (spec §18.7).
 * The text survives a closed tab, a reload, a crash and another device. A surface calls `set` as the
 * student types, `clear` when the answer is submitted or discarded, and shows `status`.
 *
 *   const draft = useServerDraft<RecallDraft>('recall', `${topicId}:${cardKey}`, { projectId, topicId, parse })
 *   draft.value            the stored draft, or null while there is none (also null while loading, unless the cache has one)
 *   draft.set(next)        keep this value; `next` may be a function of the previous one
 *   await draft.clear()    the answer was submitted or discarded: delete the draft
 *   await draft.flush()    save now and wait (before leaving the page by a route change you control)
 *   draft.status           'loading' | 'saved' | 'saving' | 'offline' | 'error'
 *   draft.conflict         'server_won' when another tab or device had a newer draft and it replaced yours; null otherwise
 *   draft.refused          { opensAt } when a new quiz draft was refused because that set was taken today; null otherwise
 *   draft.error            why status is 'error': 'too_large' | 'rejected'; null otherwise
 *
 * Arguments
 *   surface  'quiz' | 'recall' | 'reader_check' | 'explainer_check' | 'review' | 'practice'
 *   key      the surface's scope key (lib/drafts/draft-contract.ts, spec §18.7 table), or null to switch the
 *            draft off until the id is known. Changing the key switches to that draft (the old one is saved first).
 *   opts.projectId  the project the draft belongs to; required to save. Null switches the draft off.
 *   opts.topicId    the topic, for surfaces whose key starts with one (quiz, recall, explainer_check).
 *   opts.parse      turns a stored value into T, or returns null for one that is not usable (an older shape).
 *                   Both the server's and the cache's values pass through it. Without it values are used as they are.
 *
 * Rules a surface follows
 *   - `set` only when the student changed something; call `clear()` instead of `set` for an empty answer.
 *   - Call `clear()` after the answer is submitted successfully, not before: a failed submit keeps its text.
 *   - Show `status` as a quiet line: "Saved", "Saving…", "Saved on this device; will sync when you're back online."
 *     (`statusLabel`). For 'error' show nothing alarming unless `error === 'too_large'`: the text is still on this device.
 *   - `value` is for the surface's own state: seed the input from it once `status !== 'loading'`.
 *
 * Behaviour (the engine is lib/drafts/draft-sync.ts)
 *   - Saves 800 ms after the last change (at most 10 s into a burst), one request at a time.
 *   - On `pagehide`, when the tab is hidden and when the component unmounts, unsaved text is sent with `keepalive`.
 *   - sessionStorage is a write-through cache: every change is written there at once, so typing works offline
 *     and a reload before the save lands loses nothing. At start the cache and the server are compared and
 *     the newer `updatedAt` wins (`mergeDraft`).
 *   - Offline or failing saves retry after 2, 4, 8, 16, then every 30 seconds, and at once when the browser
 *     reports it is back online or the tab becomes visible.
 *   - When two tabs write, the server takes the first and answers the second with the stored draft; the newer
 *     edit wins. When the other tab's was newer, `value` becomes theirs and `conflict` is 'server_won'.
 */

import * as React from 'react'
import { createFetchTransport, createSessionCache } from '@/lib/drafts/draft-client'
import { createDraftEngine, type DraftEngine, type SyncError, type SyncSnapshot, type SyncStatus } from '@/lib/drafts/draft-sync'
import type { DraftSurface } from '@/lib/drafts/draft-contract'

export type UseServerDraftOptions<T> = {
  projectId: string | null | undefined
  topicId?: string | null
  parse?: (raw: unknown) => T | null
}

export type ServerDraft<T> = {
  value: T | null
  set: (next: T | ((previous: T | null) => T)) => void
  clear: () => Promise<void>
  flush: () => Promise<void>
  status: SyncStatus
  conflict: 'server_won' | null
  refused: { opensAt: string } | null
  error: SyncError | null
}

/** The status line, as draft copy for Harish to review. */
export const DRAFT_STATUS_COPY = {
  saved: 'Saved',
  saving: 'Saving…',
  offline: "Saved on this device; will sync when you're back online.",
} as const

/** The line for a status, or null when there is nothing to say (loading, or an error shown another way). */
export function statusLabel(status: SyncStatus): string | null {
  return status === 'saved' || status === 'saving' || status === 'offline' ? DRAFT_STATUS_COPY[status] : null
}

const EMPTY: SyncSnapshot = { value: null, status: 'loading', conflict: null, refused: null, error: null }
const realTimers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export function useServerDraft<T>(surface: DraftSurface, key: string | null, options: UseServerDraftOptions<T>): ServerDraft<T> {
  const { projectId, topicId = null } = options
  const parseRef = React.useRef(options.parse)
  React.useEffect(() => {
    parseRef.current = options.parse
  })

  const slot = projectId && key ? `${surface}|${key}|${projectId}|${topicId ?? ''}` : null
  const [state, setState] = React.useState<{ slot: string | null; snapshot: SyncSnapshot }>({ slot, snapshot: EMPTY })
  const engineRef = React.useRef<DraftEngine | null>(null)
  const valueRef = React.useRef<T | null>(null)

  React.useEffect(() => {
    engineRef.current = null
    if (!slot || !projectId || !key) return
    const engine = createDraftEngine({
      timers: realTimers,
      parse: (raw) => (parseRef.current ? parseRef.current(raw) : raw),
      transport: createFetchTransport({ surface, key, projectId, topicId }),
      cache: createSessionCache(surface, key),
      onChange: (snapshot) => {
        valueRef.current = snapshot.value as T | null
        setState({ slot, snapshot })
      },
    })
    engineRef.current = engine
    const onPageHide = () => engine.flushKeepalive()
    const onVisibility = () => (document.visibilityState === 'hidden' ? engine.flushKeepalive() : engine.retryNow())
    const onOnline = () => engine.retryNow()
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibility)
    void engine.start()
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibility)
      // A route change or a switch of key: send what is unsaved before letting go.
      engine.flushKeepalive()
      engine.dispose()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [slot, surface, key, projectId, topicId])

  const set = React.useCallback((next: T | ((previous: T | null) => T)) => {
    const engine = engineRef.current
    if (!engine) return
    engine.set(typeof next === 'function' ? (next as (previous: T | null) => T)(valueRef.current) : next)
  }, [])
  const clear = React.useCallback(async () => {
    await engineRef.current?.clear()
  }, [])
  const flush = React.useCallback(async () => {
    await engineRef.current?.flush()
  }, [])

  // A snapshot from a previous key is not this draft's.
  const snapshot = state.slot === slot ? state.snapshot : EMPTY
  return {
    value: slot ? (snapshot.value as T | null) : null,
    set,
    clear,
    flush,
    status: slot ? snapshot.status : 'saved',
    conflict: snapshot.conflict,
    refused: snapshot.refused,
    error: snapshot.error,
  }
}
