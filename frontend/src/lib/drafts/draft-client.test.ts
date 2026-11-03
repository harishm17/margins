import test from 'node:test'
import assert from 'node:assert/strict'
import { createFetchTransport, createSessionCache, draftCacheKey } from './draft-client'

const target = { surface: 'recall' as const, key: 't1:c0', projectId: 'p1', topicId: 't1' }
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const transportFor = (respond: (input: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { input: string; init?: RequestInit }[] = []
  const transport = createFetchTransport(target, async (input, init) => {
    calls.push({ input, init })
    return respond(input, init)
  })
  return { transport, calls }
}
const down = () => {
  throw new TypeError('Failed to fetch')
}

test('get: a stored draft, no draft, trouble', async () => {
  const stored = { draft: { payload: { text: 'a' }, version: 3, updatedAt: '2026-11-02T10:00:00.000Z', expiresAt: 'x' } }
  const a = transportFor(() => reply(200, stored))
  assert.deepEqual(await a.transport.get(), { kind: 'ok', draft: { payload: { text: 'a' }, version: 3, updatedAtMs: Date.parse('2026-11-02T10:00:00.000Z') } })
  assert.equal(a.calls[0].input, '/api/drafts?surface=recall&key=t1%3Ac0')
  assert.deepEqual(await transportFor(() => reply(200, { draft: null })).transport.get(), { kind: 'ok', draft: null })
  assert.deepEqual(await transportFor(down).transport.get(), { kind: 'offline' })
  assert.deepEqual(await transportFor(() => reply(503)).transport.get(), { kind: 'offline' })
  assert.deepEqual(await transportFor(() => reply(401)).transport.get(), { kind: 'offline' })
  assert.deepEqual(await transportFor(() => reply(400)).transport.get(), { kind: 'error' })
})

test('put: sends payload, version and scope; keepalive is passed through', async () => {
  const h = transportFor(() => reply(200, { draft: { payload: {}, version: 2, updatedAt: '2026-11-02T10:00:00.000Z', expiresAt: 'x' } }))
  const result = await h.transport.put({ text: 'x', voice: false }, 1, { keepalive: true })
  assert.equal(result.kind, 'saved')
  assert.ok(result.kind === 'saved' && result.version === 2)
  assert.equal(h.calls[0].init?.method, 'PUT')
  assert.equal(h.calls[0].init?.keepalive, true)
  assert.deepEqual(JSON.parse(String(h.calls[0].init?.body)), { payload: { text: 'x', voice: false }, version: 1, projectId: 'p1', topicId: 't1' })
})

test('put: maps conflicts, refusals, size and trouble', async () => {
  const conflict = reply(409, { error: { code: 'CONFLICT', details: { code: 'STALE_VERSION', draft: { payload: { text: 'b' }, version: 5, updatedAt: '2026-11-02T10:00:00.000Z' } } } })
  assert.deepEqual(await transportFor(() => conflict).transport.put({}, 1, { keepalive: false }), {
    kind: 'conflict',
    draft: { payload: { text: 'b' }, version: 5, updatedAtMs: Date.parse('2026-11-02T10:00:00.000Z') },
  })
  const gone = reply(409, { error: { details: { code: 'STALE_VERSION', draft: null } } })
  assert.deepEqual(await transportFor(() => gone).transport.put({}, 1, { keepalive: false }), { kind: 'conflict', draft: null })
  const tomorrow = reply(409, { error: { details: { code: 'RETRY_TOMORROW', opensAt: '2026-11-03T08:00:00.000Z' } } })
  assert.deepEqual(await transportFor(() => tomorrow).transport.put({}, 0, { keepalive: false }), { kind: 'refused', opensAt: '2026-11-03T08:00:00.000Z' })
  assert.deepEqual(await transportFor(() => reply(413, { error: { details: { code: 'PAYLOAD_TOO_LARGE' } } })).transport.put({}, 0, { keepalive: false }), { kind: 'rejected', reason: 'too_large' })
  assert.deepEqual(await transportFor(() => reply(400)).transport.put({}, 0, { keepalive: false }), { kind: 'rejected', reason: 'rejected' })
  assert.deepEqual(await transportFor(() => reply(404)).transport.put({}, 0, { keepalive: false }), { kind: 'rejected', reason: 'rejected' })
  assert.deepEqual(await transportFor(down).transport.put({}, 0, { keepalive: false }), { kind: 'offline' })
  assert.deepEqual(await transportFor(() => reply(502)).transport.put({}, 0, { keepalive: false }), { kind: 'offline' })
  assert.deepEqual(await transportFor(() => reply(429, {}, { 'Retry-After': '7' })).transport.put({}, 0, { keepalive: false }), { kind: 'offline', retryAfterMs: 7000 })
})

test('delete: done, already gone, later', async () => {
  assert.deepEqual(await transportFor(() => reply(200, { ok: true })).transport.delete(), { kind: 'ok' })
  assert.deepEqual(await transportFor(() => reply(400)).transport.delete(), { kind: 'ok' })
  assert.deepEqual(await transportFor(() => reply(500)).transport.delete(), { kind: 'offline' })
  assert.deepEqual(await transportFor(down).transport.delete(), { kind: 'offline' })
})

test('session cache: round trip, garbage, and storage that throws', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }
  const cache = createSessionCache('recall', 't1:c0', storage)
  assert.equal(cache.read(), null)
  cache.write({ value: { text: 'a' }, version: 2, editedAt: 5, dirty: true })
  assert.deepEqual(cache.read(), { value: { text: 'a' }, version: 2, editedAt: 5, dirty: true })
  assert.ok(data.has(draftCacheKey('recall', 't1:c0')))
  cache.write(null)
  assert.equal(cache.read(), null)
  data.set(draftCacheKey('recall', 't1:c0'), '{not json')
  assert.equal(cache.read(), null)
  const broken = createSessionCache('recall', 'k:j', {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('denied') },
  })
  assert.equal(broken.read(), null)
  assert.doesNotThrow(() => broken.write({ value: 1, version: 0, editedAt: 1, dirty: true }))
  assert.equal(createSessionCache('recall', 'k:j', null).read(), null)
})
