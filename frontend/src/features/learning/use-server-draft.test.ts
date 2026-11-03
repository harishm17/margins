/**
 * The pure parts of useServerDraft: the cache-against-server merge rule, the debounce scheduler and
 * the save engine (conflicts, offline, clear, flush), run against a fake clock and a fake server.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDebouncer,
  createDraftEngine,
  mergeDraft,
  type CacheEntry,
  type DeleteResult,
  type GetResult,
  type PutResult,
  type SyncSnapshot,
  type Timers,
} from '@/lib/drafts/draft-sync'

// ---- A fake clock ----

function fakeClock() {
  let now = 1_000_000
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle) => void pending.delete(handle as number),
  }
  return {
    timers,
    pendingCount: () => pending.size,
    /** Moves time forward, firing timers in order, letting promises settle between them. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
        await settle()
      }
      now = end
    },
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// ---- The merge rule ----

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({ value: { text: 'cache' }, version: 2, editedAt: 5000, dirty: true, ...over })
const server = (over: Partial<{ payload: unknown; version: number; updatedAtMs: number }> = {}) => ({ payload: { text: 'server' }, version: 3, updatedAtMs: 4000, ...over })

test('newer of cache and server wins', () => {
  // The cache has unsaved edits made after the server's draft was written: the cache wins.
  assert.deepEqual(mergeDraft(entry({ editedAt: 5000 }), server({ updatedAtMs: 4000 })), { take: 'cache', baseVersion: 3 })
  // The server's draft is newer than the cache's edits: the server wins and says edits were lost.
  assert.deepEqual(mergeDraft(entry({ editedAt: 3000 }), server({ updatedAtMs: 4000 })), { take: 'server', draft: server(), lostLocal: true })
  // A tie goes to the server.
  assert.equal(mergeDraft(entry({ editedAt: 4000 }), server({ updatedAtMs: 4000 })).take, 'server')
})

test('merge: no conflict when the server has not moved, or holds the same text', () => {
  assert.deepEqual(mergeDraft(entry({ version: 3 }), server({ version: 3, updatedAtMs: 9000 })), { take: 'cache', baseVersion: 3 })
  const same = mergeDraft(entry({ editedAt: 3000 }), server({ payload: { text: 'cache' } }))
  assert.ok(same.take === 'server' && same.lostLocal === false)
})

test('merge: server only, cache only, clean cache, cleared elsewhere, tombstone', () => {
  assert.equal(mergeDraft(null, server()).take, 'server')
  assert.equal(mergeDraft(null, null).take, 'none')
  // Unsaved edits and a server with nothing: write them (the draft expired, or this is the first save).
  assert.deepEqual(mergeDraft(entry(), null), { take: 'cache', baseVersion: 0 })
  // A saved cache is only a copy: the server wins, even over a newer clock.
  const clean = mergeDraft(entry({ dirty: false, editedAt: 99_000 }), server())
  assert.ok(clean.take === 'server' && clean.lostLocal === false)
  // A saved cache and no server draft: it was cleared on another device.
  assert.equal(mergeDraft(entry({ dirty: false }), null).take, 'none')
  assert.equal(mergeDraft(entry({ tombstone: true, dirty: false }), server()).take, 'delete')
})

// ---- The debouncer ----

test('debounce: one call after quiet, waits again on each call, never longer than the max wait', async () => {
  const clock = fakeClock()
  let calls = 0
  const debounced = createDebouncer(() => calls++, clock.timers, 800, 10_000)
  debounced.schedule()
  await clock.advance(700)
  debounced.schedule()
  await clock.advance(700)
  assert.equal(calls, 0)
  await clock.advance(100)
  assert.equal(calls, 1)
  // Typing without a pause: it still fires at the max wait.
  for (let i = 0; i < 40; i++) {
    debounced.schedule()
    await clock.advance(500)
  }
  assert.ok(calls >= 2, `fired during the burst (${calls})`)
  debounced.cancel()
  await clock.advance(5000)
  const before = calls
  await clock.advance(5000)
  assert.equal(calls, before)
})

// ---- The engine ----

type Put = { payload: unknown; version: number; keepalive: boolean }
function harness(opts: { cached?: CacheEntry | null; get?: GetResult; parse?: (raw: unknown) => unknown | null } = {}) {
  const clock = fakeClock()
  const log: { puts: Put[]; deletes: number; gets: number; snapshots: SyncSnapshot[] } = { puts: [], deletes: 0, gets: 0, snapshots: [] }
  let cached: CacheEntry | null = opts.cached ?? null
  const script = {
    get: opts.get ?? ({ kind: 'ok', draft: null } as GetResult),
    put: [] as PutResult[],
    del: [] as DeleteResult[],
    gate: null as Promise<void> | null,
    putDefault: (v: number): PutResult => ({ kind: 'saved', version: v + 1, updatedAtMs: clock.timers.now() }),
  }
  const engine = createDraftEngine({
    timers: clock.timers,
    parse: opts.parse,
    cache: { read: () => cached, write: (e) => void (cached = e) },
    onChange: (s) => log.snapshots.push(s),
    transport: {
      get: async () => (log.gets++, script.get),
      put: async (payload, version, o) => {
        log.puts.push({ payload, version, keepalive: o.keepalive })
        if (script.gate) await script.gate
        return script.put.shift() ?? script.putDefault(version)
      },
      delete: async () => (log.deletes++, script.del.shift() ?? { kind: 'ok' }),
    },
  })
  const last = () => log.snapshots[log.snapshots.length - 1]
  return { clock, log, script, engine, last, cache: () => cached }
}

test('engine: loads the draft from the server', async () => {
  const h = harness({ get: { kind: 'ok', draft: { payload: { text: 'hi' }, version: 4, updatedAtMs: 10 } } })
  await h.engine.start()
  assert.deepEqual(h.last().value, { text: 'hi' })
  assert.equal(h.last().status, 'saved')
  assert.deepEqual((h.cache() as CacheEntry).value, { text: 'hi' })
})

test('engine: shows the cache while loading, and an empty server with a saved cache means cleared elsewhere', async () => {
  const h = harness({ cached: entry({ dirty: false }) })
  const started = h.engine.start()
  assert.deepEqual(h.log.snapshots[0].value, { text: 'cache' })
  assert.equal(h.log.snapshots[0].status, 'loading')
  await started
  assert.equal(h.last().value, null)
  assert.equal(h.cache(), null)
})

test('engine: edits are saved after 800 ms of quiet, in one request, with the version', async () => {
  const h = harness({ get: { kind: 'ok', draft: { payload: { text: 'a' }, version: 4, updatedAtMs: 10 } } })
  await h.engine.start()
  h.engine.set({ text: 'ab' })
  h.engine.set({ text: 'abc' })
  assert.equal(h.last().status, 'saving')
  await h.clock.advance(799)
  assert.equal(h.log.puts.length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.log.puts, [{ payload: { text: 'abc' }, version: 4, keepalive: false }])
  assert.equal(h.last().status, 'saved')
  // The next save carries the version the server returned.
  h.engine.set({ text: 'abcd' })
  await h.clock.advance(800)
  assert.equal(h.log.puts[1].version, 5)
})

test('engine: the cache is written on every edit, before the server hears of it', async () => {
  const h = harness()
  await h.engine.start()
  h.engine.set({ text: 'typed' })
  const c = h.cache() as CacheEntry
  assert.deepEqual([c.value, c.dirty], [{ text: 'typed' }, true])
  await h.clock.advance(800)
  assert.equal((h.cache() as CacheEntry).dirty, false)
})

test('engine: an edit made while a save is in flight is saved next, not lost', async () => {
  const h = harness()
  await h.engine.start()
  let release!: () => void
  h.script.gate = new Promise<void>((r) => (release = r))
  h.engine.set({ text: 'one' })
  await h.clock.advance(800) // request one is now open
  h.engine.set({ text: 'two' })
  h.script.gate = null
  release()
  await h.clock.advance(800) // its timer fires while request one is still open and does nothing
  await h.clock.advance(800) // request one finished and set the timer again
  assert.deepEqual(h.log.puts.map((p) => [(p.payload as { text: string }).text, p.version]), [['one', 0], ['two', 1]])
  assert.equal(h.last().status, 'saved')
})

test('pagehide while a save is in flight sends nothing extra (the cache keeps the newer text)', async () => {
  const h = harness()
  await h.engine.start()
  let release!: () => void
  h.script.gate = new Promise<void>((r) => (release = r))
  h.engine.set({ text: 'one' })
  await h.clock.advance(800)
  h.engine.set({ text: 'two' })
  h.engine.flushKeepalive()
  await settle()
  assert.equal(h.log.puts.length, 1)
  assert.equal((h.cache() as CacheEntry).dirty, true)
  release()
})

test('engine: a stale version where the other tab is newer takes the server and reports the conflict', async () => {
  const h = harness({ get: { kind: 'ok', draft: { payload: { text: 'a' }, version: 1, updatedAtMs: 10 } } })
  await h.engine.start()
  h.script.put.push({ kind: 'conflict', draft: { payload: { text: 'from other tab' }, version: 2, updatedAtMs: h.clock.timers.now() + 5000 } })
  h.engine.set({ text: 'mine' })
  await h.clock.advance(800)
  assert.deepEqual(h.last().value, { text: 'from other tab' })
  assert.equal(h.last().conflict, 'server_won')
  assert.equal(h.last().status, 'saved')
  assert.equal(h.log.puts.length, 1)
  // The next edit clears the notice and builds on the server's version.
  h.engine.set({ text: 'from other tab, plus' })
  assert.equal(h.last().conflict, null)
  await h.clock.advance(800)
  assert.equal(h.log.puts[1].version, 2)
})

test('engine: a stale version where this edit is newer overwrites with the server version', async () => {
  const h = harness({ get: { kind: 'ok', draft: { payload: { text: 'a' }, version: 1, updatedAtMs: 10 } } })
  await h.engine.start()
  h.script.put.push({ kind: 'conflict', draft: { payload: { text: 'old' }, version: 2, updatedAtMs: 20 } })
  h.engine.set({ text: 'mine' })
  await h.clock.advance(800)
  assert.deepEqual(h.log.puts.map((p) => p.version), [1, 2])
  assert.deepEqual(h.last().value, { text: 'mine' })
  assert.equal(h.last().conflict, null)
})

test('engine: a conflict because the draft is gone writes our edits again from version 0', async () => {
  const h = harness({ get: { kind: 'ok', draft: { payload: { text: 'a' }, version: 3, updatedAtMs: 10 } } })
  await h.engine.start()
  h.script.put.push({ kind: 'conflict', draft: null })
  h.engine.set({ text: 'mine' })
  await h.clock.advance(800)
  assert.deepEqual(h.log.puts.map((p) => p.version), [3, 0])
  assert.equal(h.last().status, 'saved')
})

test('failed save: goes offline, keeps the text in the cache, retries with backoff and then syncs', async () => {
  const h = harness()
  await h.engine.start()
  h.script.put.push({ kind: 'offline' }, { kind: 'offline' })
  h.engine.set({ text: 'typed on the train' })
  await h.clock.advance(800)
  assert.equal(h.last().status, 'offline')
  assert.equal((h.cache() as CacheEntry).dirty, true)
  assert.deepEqual(h.last().value, { text: 'typed on the train' })
  await h.clock.advance(1999)
  assert.equal(h.log.puts.length, 1)
  await h.clock.advance(1) // first retry at 2 s: fails again
  assert.equal(h.log.puts.length, 2)
  assert.equal(h.last().status, 'offline')
  await h.clock.advance(3999)
  assert.equal(h.log.puts.length, 2)
  await h.clock.advance(1) // second retry at 4 s: succeeds
  assert.equal(h.log.puts.length, 3)
  assert.equal(h.last().status, 'saved')
  assert.equal((h.cache() as CacheEntry).dirty, false)
})

test('failed save: Retry-After is respected and "online" retries at once', async () => {
  const h = harness()
  await h.engine.start()
  h.script.put.push({ kind: 'offline', retryAfterMs: 20_000 })
  h.engine.set({ text: 'x' })
  await h.clock.advance(800)
  await h.clock.advance(10_000)
  assert.equal(h.log.puts.length, 1)
  h.engine.retryNow()
  await settle()
  assert.equal(h.log.puts.length, 2)
  assert.equal(h.last().status, 'saved')
})

test('offline while loading: shows the cache, retries the load, then pushes unsaved edits', async () => {
  const h = harness({ cached: entry({ version: 0, dirty: true }), get: { kind: 'offline' } })
  await h.engine.start()
  assert.equal(h.last().status, 'offline')
  assert.deepEqual(h.last().value, { text: 'cache' })
  h.script.get = { kind: 'ok', draft: null }
  await h.clock.advance(2000)
  assert.equal(h.log.gets, 2)
  assert.equal(h.log.puts.length, 1)
  assert.equal(h.last().status, 'saved')
})

test('a rejected save (too large, invalid) is an error, not retried, and the next edit tries again', async () => {
  const h = harness()
  await h.engine.start()
  h.script.put.push({ kind: 'rejected', reason: 'rejected' })
  h.engine.set({ text: 'x' })
  await h.clock.advance(800)
  assert.equal(h.last().status, 'error')
  await h.clock.advance(60_000)
  assert.equal(h.log.puts.length, 1)
  h.engine.set({ text: 'xy' })
  await h.clock.advance(800)
  assert.equal(h.log.puts.length, 2)
  assert.equal(h.last().status, 'saved')
})

test('an oversized value is stopped before it is sent', async () => {
  const h = harness()
  await h.engine.start()
  h.engine.set({ text: 'x'.repeat(20_000) })
  await h.clock.advance(800)
  assert.equal(h.log.puts.length, 0)
  assert.deepEqual([h.last().status, h.last().error], ['error', 'too_large'])
  assert.equal((h.cache() as CacheEntry).dirty, true)
})

test('a refused quiz draft (taken today) is reported with when it opens', async () => {
  const h = harness()
  await h.engine.start()
  h.script.put.push({ kind: 'refused', opensAt: '2026-11-03T08:00:00.000Z' })
  h.engine.set({ answers: {}, index: 0 })
  await h.clock.advance(800)
  assert.deepEqual(h.last().refused, { opensAt: '2026-11-03T08:00:00.000Z' })
  assert.equal(h.last().status, 'error')
})

test('pagehide: unsaved edits go out at once with keepalive', async () => {
  const h = harness()
  await h.engine.start()
  h.engine.set({ text: 'closing the tab' })
  h.engine.flushKeepalive()
  await settle()
  assert.deepEqual(h.log.puts, [{ payload: { text: 'closing the tab' }, version: 0, keepalive: true }])
  await h.clock.advance(5000)
  assert.equal(h.log.puts.length, 1, 'the debounce timer was cancelled')
})

test('pagehide with nothing unsaved sends nothing', async () => {
  const h = harness({ get: { kind: 'ok', draft: { payload: { text: 'a' }, version: 1, updatedAtMs: 1 } } })
  await h.engine.start()
  h.engine.flushKeepalive()
  await settle()
  assert.equal(h.log.puts.length, 0)
})

test('flush waits for the save to finish', async () => {
  const h = harness()
  await h.engine.start()
  h.engine.set({ text: 'before submit' })
  await h.engine.flush()
  assert.equal(h.log.puts.length, 1)
  assert.equal(h.last().status, 'saved')
})

test('clear deletes on the server, cancels pending saves, and a failed delete is retried', async () => {
  const h = harness({ get: { kind: 'ok', draft: { payload: { text: 'a' }, version: 1, updatedAtMs: 1 } } })
  await h.engine.start()
  h.engine.set({ text: 'about to submit' })
  h.script.del.push({ kind: 'offline' })
  await h.engine.clear()
  assert.equal(h.log.puts.length, 0, 'the pending save never goes out')
  assert.equal(h.last().value, null)
  assert.equal(h.last().status, 'offline')
  assert.equal((h.cache() as CacheEntry).tombstone, true)
  await h.clock.advance(2000)
  assert.equal(h.log.deletes, 2)
  assert.equal(h.last().status, 'saved')
  assert.equal(h.cache(), null)
})

test('a tombstone left in the cache is deleted on the next load, whatever the server holds', async () => {
  const h = harness({
    cached: { value: null, version: 1, editedAt: 1, dirty: false, tombstone: true },
    get: { kind: 'ok', draft: { payload: { text: 'a' }, version: 1, updatedAtMs: 1 } },
  })
  await h.engine.start()
  assert.equal(h.log.deletes, 1)
  assert.equal(h.last().value, null)
  assert.equal(h.cache(), null)
})

test('values the surface cannot parse are ignored, from the server and from the cache', async () => {
  const parse = (raw: unknown) => (raw && typeof raw === 'object' && 'text' in raw ? raw : null)
  const bad = harness({ parse, cached: entry({ value: { nope: 1 }, dirty: false }), get: { kind: 'ok', draft: { payload: { nope: 2 }, version: 2, updatedAtMs: 1 } } })
  await bad.engine.start()
  assert.equal(bad.last().value, null)
})

test('after dispose nothing more is sent', async () => {
  const h = harness()
  await h.engine.start()
  h.engine.set({ text: 'x' })
  h.engine.dispose()
  await h.clock.advance(60_000)
  assert.equal(h.log.puts.length, 0)
})

test('status lines: the three drafts, and nothing for loading or error', async () => {
  const { statusLabel } = await import('./use-server-draft')
  assert.equal(statusLabel('saved'), 'Saved')
  assert.equal(statusLabel('saving'), 'Saving…')
  assert.equal(statusLabel('offline'), "Saved on this device; will sync when you're back online.")
  assert.equal(statusLabel('loading'), null)
  assert.equal(statusLabel('error'), null)
})
