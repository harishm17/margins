/**
 * The logic behind useServerDraft (spec §18.7), with no React, fetch or storage in it so it can be
 * tested with a fake clock: the merge rule for cache against server, and the engine that debounces,
 * saves one request at a time, settles conflicts and survives being offline.
 *
 * The sessionStorage cache is only a cache: it holds the latest value even when the server cannot be
 * reached, and it is read once at start to be compared with the server by `mergeDraft`. Once the
 * server has answered it is a copy, never the source of truth.
 */

import { DRAFT_DEBOUNCE_MS, DRAFT_MAX_WAIT_MS, MAX_DRAFT_BYTES, payloadBytes } from './draft-contract'

export type SyncStatus = 'loading' | 'saved' | 'saving' | 'offline' | 'error'
/** Why status is 'error': the size check or the server refused this content for good. Changing it may fix it. */
export type SyncError = 'too_large' | 'rejected'

/** What the cache holds for one draft. */
export type CacheEntry = {
  value: unknown
  /** The server version this value was last known to be based on; 0 when none. */
  version: number
  /** When the student last changed it (client clock, ms). */
  editedAt: number
  /** Changed since the last save the server confirmed. */
  dirty: boolean
  /** The student cleared it (submitted) and the server has not confirmed the delete yet. */
  tombstone?: boolean
}

export type ServerDraft = { payload: unknown; version: number; updatedAtMs: number }

export type Merge =
  | { take: 'none' }
  | { take: 'server'; draft: ServerDraft; lostLocal: boolean }
  | { take: 'cache'; baseVersion: number }
  | { take: 'delete' }

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Which side of a cache entry and the server's draft wins at start.
 * - No cache: the server's draft, if any.
 * - Tombstone: the student cleared it; delete it on the server too.
 * - Saved cache: the server is the truth (a saved cache with the server's draft gone means it was
 *   cleared on another device).
 * - Unsaved cache: it has edits the server never saw. If the server has not moved since (same
 *   version, or no draft), the cache is pushed. If it has moved, the newer `updatedAt` wins and a tie
 *   goes to the server. Identical content is not a conflict. Two clocks are compared, so a client
 *   clock that is minutes off can pick the wrong side; the cost is one stale draft.
 */
export function mergeDraft(cache: CacheEntry | null, server: ServerDraft | null): Merge {
  if (!cache) return server ? { take: 'server', draft: server, lostLocal: false } : { take: 'none' }
  if (cache.tombstone) return { take: 'delete' }
  if (!cache.dirty) return server ? { take: 'server', draft: server, lostLocal: false } : { take: 'none' }
  if (!server) return { take: 'cache', baseVersion: 0 }
  if (server.version === cache.version) return { take: 'cache', baseVersion: server.version }
  if (sameJson(server.payload, cache.value)) return { take: 'server', draft: server, lostLocal: false }
  if (cache.editedAt > server.updatedAtMs) return { take: 'cache', baseVersion: server.version }
  return { take: 'server', draft: server, lostLocal: true }
}

// ---- Debounce with a maximum wait ----

export type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
}

/**
 * Runs `fn` after `delayMs` of quiet, but never later than `maxWaitMs` after the first call of a
 * burst, so someone typing without a pause still gets saved.
 */
export function createDebouncer(fn: () => void, timers: Timers, delayMs = DRAFT_DEBOUNCE_MS, maxWaitMs = DRAFT_MAX_WAIT_MS) {
  let handle: unknown = null
  let burstStart = 0
  const run = () => {
    handle = null
    fn()
  }
  return {
    schedule() {
      const now = timers.now()
      if (handle !== null) timers.clearTimeout(handle)
      else burstStart = now
      handle = timers.setTimeout(run, Math.max(0, Math.min(delayMs, burstStart + maxWaitMs - now)))
    },
    cancel() {
      if (handle !== null) timers.clearTimeout(handle)
      handle = null
    },
    pending: () => handle !== null,
  }
}

// ---- The engine ----

export type GetResult = { kind: 'ok'; draft: ServerDraft | null } | { kind: 'offline' } | { kind: 'error' }
export type PutResult =
  | { kind: 'saved'; version: number; updatedAtMs: number }
  | { kind: 'conflict'; draft: ServerDraft | null }
  | { kind: 'refused'; opensAt: string }
  | { kind: 'offline'; retryAfterMs?: number }
  | { kind: 'rejected'; reason: SyncError }
export type DeleteResult = { kind: 'ok' } | { kind: 'offline' }

export type Transport = {
  get: () => Promise<GetResult>
  put: (payload: unknown, version: number, options: { keepalive: boolean }) => Promise<PutResult>
  delete: () => Promise<DeleteResult>
}
export type Cache = { read: () => CacheEntry | null; write: (entry: CacheEntry | null) => void }

export type SyncSnapshot = {
  /** The current value; null when there is no draft. */
  value: unknown
  status: SyncStatus
  /** Set when another tab's or device's newer draft replaced edits made here. Reset by the next edit. */
  conflict: 'server_won' | null
  /** Set when a new quiz draft was refused because the set was taken today. */
  refused: { opensAt: string } | null
  error: SyncError | null
}

export type EngineOptions = {
  transport: Transport
  cache: Cache
  timers: Timers
  onChange: (snapshot: SyncSnapshot) => void
  /** Turns a stored value (server or cache) into the surface's type, or null when it is not usable. */
  parse?: (raw: unknown) => unknown | null
  debounceMs?: number
  maxWaitMs?: number
}

const BACKOFF_MS = [2000, 4000, 8000, 16_000, 30_000]
const MAX_CONFLICT_ROUNDS = 3

export function createDraftEngine(options: EngineOptions) {
  const { transport, cache, timers } = options
  const parse = options.parse ?? ((raw: unknown) => raw)

  let value: unknown = null
  let version = 0
  let editedAt = 0
  let editSeq = 0
  let dirty = false
  let tombstone = false
  let loaded = false
  let status: SyncStatus = 'loading'
  let conflict: SyncSnapshot['conflict'] = null
  let refused: SyncSnapshot['refused'] = null
  let error: SyncError | null = null
  let disposed = false
  let inflight: Promise<void> | null = null
  let failures = 0
  let retryHandle: unknown = null

  const emit = () => options.onChange({ value, status, conflict, refused, error })
  const writeCache = () => {
    if (tombstone) cache.write({ value: null, version, editedAt, dirty: false, tombstone: true })
    else if (value === null) cache.write(null)
    else cache.write({ value, version, editedAt, dirty })
  }
  const cancelRetry = () => {
    if (retryHandle !== null) timers.clearTimeout(retryHandle)
    retryHandle = null
  }
  const debouncer = createDebouncer(() => void drain(false), timers, options.debounceMs, options.maxWaitMs)

  /** Whatever is waiting on the network: the first load, a delete, or the unsaved value. */
  const retryWork = () => (!loaded ? load() : tombstone ? sendDelete() : drain(false))

  function goOffline(retryAfterMs?: number) {
    status = 'offline'
    emit()
    cancelRetry()
    if (disposed) return
    const wait = Math.max(retryAfterMs ?? 0, BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)])
    failures += 1
    retryHandle = timers.setTimeout(() => {
      retryHandle = null
      void retryWork()
    }, wait)
  }

  async function sendDelete() {
    const result = await transport.delete()
    if (disposed) return
    if (result.kind === 'ok') {
      tombstone = false
      failures = 0
      cache.write(null)
      status = 'saved'
      emit()
    } else goOffline()
  }

  /** Saves the current value once, repeating when a conflict is settled in our favour. */
  function drain(keepalive: boolean): Promise<void> {
    if (inflight) return inflight
    if (!dirty || tombstone || disposed || !loaded) return Promise.resolve()
    inflight = (async () => {
      try {
        for (let round = 0; round < MAX_CONFLICT_ROUNDS && dirty && !tombstone; round++) {
          if (payloadBytes(value) > MAX_DRAFT_BYTES) {
            status = 'error'
            error = 'too_large'
            emit()
            return
          }
          const seq = editSeq
          status = 'saving'
          emit()
          const result = await transport.put(value, version, { keepalive })
          if (disposed) return
          if (result.kind === 'saved') {
            version = result.version
            failures = 0
            cancelRetry()
            if (tombstone) return
            // Edits made while this was in flight keep it dirty. Their timer may have fired meanwhile, so set one again.
            if (seq === editSeq) dirty = false
            writeCache()
            status = dirty ? 'saving' : 'saved'
            if (dirty) debouncer.schedule()
            emit()
            return
          }
          if (result.kind === 'conflict') {
            const other = result.draft
            if (other === null) {
              version = 0 // gone elsewhere (submitted, expired); we still hold edits, so write them again
              continue
            }
            if (sameJson(other.payload, value)) {
              version = other.version
              if (seq === editSeq) dirty = false
              writeCache()
              status = dirty ? 'saving' : 'saved'
              if (dirty) debouncer.schedule()
              emit()
              return
            }
            if (editedAt > other.updatedAtMs) {
              version = other.version // our edit is the newer one: overwrite
              continue
            }
            const theirs = parse(other.payload)
            version = other.version
            if (theirs === null) continue
            value = theirs
            dirty = false
            conflict = 'server_won'
            writeCache()
            status = 'saved'
            emit()
            return
          }
          if (result.kind === 'refused') {
            refused = { opensAt: result.opensAt }
            status = 'error'
            error = 'rejected'
            emit()
            return
          }
          if (result.kind === 'rejected') {
            status = 'error'
            error = result.reason
            emit()
            return
          }
          goOffline(result.retryAfterMs)
          return
        }
        if (dirty && !disposed) goOffline() // kept losing conflict rounds: try again later rather than loop
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** Reads the server's draft and settles it against what is held here. */
  async function load() {
    const result = await transport.get()
    if (disposed) return
    if (result.kind === 'offline') return goOffline()
    if (result.kind === 'error') {
      // The server answered with something unusable. Work from the cache; edits will try to save.
      loaded = true
      status = 'error'
      error = 'rejected'
      emit()
      return
    }
    // Edits made while the load was in flight are newer than anything the cache held.
    const current: CacheEntry | null = tombstone
      ? { value: null, version, editedAt, dirty: false, tombstone: true }
      : value !== null
        ? { value, version, editedAt, dirty }
        : null
    const merged = mergeDraft(current, result.draft)
    loaded = true
    failures = 0
    if (merged.take === 'delete') {
      status = 'saving'
      emit()
      return sendDelete()
    }
    if (merged.take === 'server') {
      const theirs = parse(merged.draft.payload)
      version = merged.draft.version
      if (theirs !== null) {
        value = theirs
        dirty = false
        conflict = merged.lostLocal ? 'server_won' : null
        writeCache()
      }
      status = dirty ? 'saving' : 'saved'
      emit()
      return dirty ? drain(false) : undefined
    }
    if (merged.take === 'cache') {
      version = merged.baseVersion
      emit()
      return drain(false)
    }
    if (!dirty) {
      value = null
      version = 0
      cache.write(null)
    }
    status = 'saved'
    emit()
  }

  return {
    /** Reads the cache, shows it at once, then settles it against the server. */
    async start() {
      const cached = cache.read()
      if (cached) {
        version = cached.version
        editedAt = cached.editedAt
        if (cached.tombstone) tombstone = true
        else {
          const parsed = parse(cached.value)
          if (parsed !== null) {
            value = parsed
            dirty = cached.dirty
          }
        }
      }
      emit()
      await load()
    },

    /** The student changed the value. It is saved after a quiet moment. */
    set(next: unknown) {
      if (disposed) return
      value = next
      tombstone = false
      dirty = true
      editedAt = timers.now()
      editSeq++
      conflict = null
      refused = null
      error = null
      writeCache()
      cancelRetry()
      failures = 0
      status = loaded ? 'saving' : status
      emit()
      if (loaded) debouncer.schedule()
    },

    /**
     * The answer was submitted or discarded: there is no draft any more. Resolves when the server
     * agrees, or when it cannot be reached (the delete is then retried and the cache remembers it).
     */
    async clear() {
      if (disposed) return
      debouncer.cancel()
      cancelRetry()
      if (inflight) await inflight.catch(() => undefined)
      value = null
      dirty = false
      tombstone = true
      editedAt = timers.now()
      editSeq++
      conflict = null
      refused = null
      error = null
      writeCache()
      status = 'saving'
      emit()
      await sendDelete()
    },

    /** Saves now (before navigating or submitting) and waits for the answer. */
    async flush() {
      debouncer.cancel()
      for (let i = 0; i < MAX_CONFLICT_ROUNDS && dirty && status !== 'offline' && status !== 'error'; i++) await drain(false)
    },

    /** The page is going away: sends what is unsaved with `keepalive`, without waiting. */
    flushKeepalive() {
      debouncer.cancel()
      void drain(true)
    },

    /** The network is back, or the tab is visible again: tries waiting work now. */
    retryNow() {
      if (disposed || (status !== 'offline' && status !== 'error')) return
      cancelRetry()
      failures = 0
      void retryWork()
    },

    dispose() {
      disposed = true
      debouncer.cancel()
      cancelRetry()
    },
  }
}

export type DraftEngine = ReturnType<typeof createDraftEngine>
