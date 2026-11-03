/**
 * The browser's side of /api/drafts: a Transport for the sync engine (draft-sync.ts) built on fetch,
 * and the sessionStorage cache. `fetch` and the storage are passed in so both can be tested.
 */

import type { Cache, CacheEntry, DeleteResult, GetResult, PutResult, ServerDraft, Transport } from './draft-sync'
import type { DraftSurface } from './draft-contract'

type Wire = { payload?: unknown; version?: unknown; updatedAt?: unknown }
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type DraftTarget = { surface: DraftSurface; key: string; projectId: string; topicId?: string | null }

const url = (t: DraftTarget) => `/api/drafts?surface=${encodeURIComponent(t.surface)}&key=${encodeURIComponent(t.key)}`

function toServerDraft(wire: Wire | null | undefined): ServerDraft | null {
  if (!wire || typeof wire.version !== 'number') return null
  const updatedAtMs = typeof wire.updatedAt === 'string' ? Date.parse(wire.updatedAt) : NaN
  return { payload: wire.payload, version: wire.version, updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0 }
}

/** Statuses that mean "not now": signed out, timeout, rate limit, server trouble. The text stays in the cache and is sent later. */
const isTransient = (status: number) => status === 401 || status === 408 || status === 429 || status >= 500

async function json(response: Response): Promise<{ error?: { details?: { code?: string; opensAt?: string; draft?: Wire | null } }; draft?: Wire | null } | null> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

export function createFetchTransport(target: DraftTarget, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Transport {
  return {
    async get(): Promise<GetResult> {
      try {
        const response = await fetchImpl(url(target), { cache: 'no-store' })
        if (response.ok) return { kind: 'ok', draft: toServerDraft((await json(response))?.draft) }
        return isTransient(response.status) ? { kind: 'offline' } : { kind: 'error' }
      } catch {
        return { kind: 'offline' }
      }
    },

    async put(payload, version, options): Promise<PutResult> {
      try {
        const response = await fetchImpl(url(target), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload, version, projectId: target.projectId, topicId: target.topicId ?? null }),
          keepalive: options.keepalive,
        })
        if (response.ok) {
          const draft = toServerDraft((await json(response))?.draft)
          return draft ? { kind: 'saved', version: draft.version, updatedAtMs: draft.updatedAtMs } : { kind: 'offline' }
        }
        if (isTransient(response.status)) {
          const wait = retryAfterMs(response)
          return wait ? { kind: 'offline', retryAfterMs: wait } : { kind: 'offline' }
        }
        const details = (await json(response))?.error?.details
        if (response.status === 409 && details?.code === 'STALE_VERSION') return { kind: 'conflict', draft: toServerDraft(details.draft) }
        if (response.status === 409 && details?.code === 'RETRY_TOMORROW' && typeof details.opensAt === 'string') return { kind: 'refused', opensAt: details.opensAt }
        if (response.status === 413 || details?.code === 'PAYLOAD_TOO_LARGE') return { kind: 'rejected', reason: 'too_large' }
        return { kind: 'rejected', reason: 'rejected' }
      } catch {
        return { kind: 'offline' }
      }
    },

    async delete(): Promise<DeleteResult> {
      try {
        const response = await fetchImpl(url(target), { method: 'DELETE' })
        // Anything but "try later" is final: a 4xx will not get better by repeating it.
        return isTransient(response.status) ? { kind: 'offline' } : { kind: 'ok' }
      } catch {
        return { kind: 'offline' }
      }
    },
  }
}

// ---- The cache ----

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const draftCacheKey = (surface: DraftSurface, key: string) => `margins:draft:${surface}:${key}`

/** sessionStorage as a cache. Private mode, a full quota or a missing window make it a no-op rather than an error. */
export function createSessionCache(surface: DraftSurface, key: string, storage?: StorageLike | null): Cache {
  const store = (): StorageLike | null => {
    if (storage !== undefined) return storage
    try {
      return typeof window === 'undefined' ? null : window.sessionStorage
    } catch {
      return null
    }
  }
  const name = draftCacheKey(surface, key)
  return {
    read() {
      try {
        const raw = store()?.getItem(name)
        if (!raw) return null
        const entry = JSON.parse(raw) as Partial<CacheEntry>
        if (typeof entry.version !== 'number' || typeof entry.editedAt !== 'number') return null
        return { value: entry.value ?? null, version: entry.version, editedAt: entry.editedAt, dirty: entry.dirty === true, ...(entry.tombstone ? { tombstone: true } : {}) }
      } catch {
        return null
      }
    },
    write(entry) {
      try {
        if (entry === null) store()?.removeItem(name)
        else store()?.setItem(name, JSON.stringify(entry))
      } catch {
        // Quota or privacy mode: the server copy is the one that matters.
      }
    },
  }
}
