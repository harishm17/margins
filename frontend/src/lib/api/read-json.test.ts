import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { DEFAULT_MAX_BYTES, readJson } from './read-json'

const schema = z.object({ name: z.string().max(10) })
const post = (body: BodyInit | null, headers: Record<string, string> = {}, init: Record<string, unknown> = {}) =>
  new Request('http://localhost/api/x', { method: 'POST', body, headers, ...init } as RequestInit)

const status = async (result: Awaited<ReturnType<typeof readJson>>) => (result.ok ? 200 : result.response.status)

test('a body over the limit is refused with 413 when it states its length', async () => {
  const body = JSON.stringify({ name: 'a', pad: 'x'.repeat(20 * 1024 * 1024) })
  assert.equal(await status(await readJson(post(body, { 'content-length': String(body.length) }), schema)), 413)
})

test('a chunked body with no length is cut off at the limit, and the rest is not read', async () => {
  let pulled = 0
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= 320) return controller.close() // 20 MB if read to the end
      pulled++
      controller.enqueue(chunk)
    },
  })
  const result = await readJson(post(stream, {}, { duplex: 'half' }), schema)
  assert.equal(await status(result), 413)
  assert.ok(pulled < 10, `read ${pulled} chunks`)
})

test('bad JSON and a body that fails the schema are 400, the latter with the field named', async () => {
  assert.equal(await status(await readJson(post('{nope'), schema)), 400)
  const bad = await readJson(post(JSON.stringify({ name: 'much too long for this' })), schema)
  assert.equal(bad.ok, false)
  if (!bad.ok) {
    assert.equal(bad.response.status, 400)
    assert.match(JSON.stringify(await bad.response.json()), /name/)
  }
})

test('a valid body within the limit is parsed; the limit can be raised per route', async () => {
  const ok = await readJson(post(JSON.stringify({ name: 'Ada' })), schema)
  assert.deepEqual(ok.ok && ok.data, { name: 'Ada' })
  const big = JSON.stringify({ name: 'a', pad: 'x'.repeat(DEFAULT_MAX_BYTES) })
  assert.equal(await status(await readJson(post(big), schema)), 413)
  assert.equal(await status(await readJson(post(big), schema, { maxBytes: DEFAULT_MAX_BYTES * 2 })), 200)
})
