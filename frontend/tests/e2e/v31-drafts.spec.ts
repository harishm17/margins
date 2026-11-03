import { expect, request, test } from '@playwright/test'
import { signInApi } from './helpers/auth'
import { DEMO_EMAIL, demoIds } from './helpers/seed-demo'

// The draft API over HTTP with real sessions (spec §18.7): round trip, version conflicts, another
// user's access, validation. The store itself is covered by draft-store.db.test.ts.
const OTHER_EMAIL = 'drafts-other@example.com'

test('drafts API: round trip, stale version, another user, bad input', async ({ baseURL }) => {
  const topicId = demoIds().topics[0]
  const mine = await request.newContext({ baseURL })
  await signInApi(mine, DEMO_EMAIL)
  const projectId = demoIds().course
  const key = `${topicId}:e2e-${Date.now()}`
  const url = `/api/drafts?surface=recall&key=${encodeURIComponent(key)}`
  const body = (text: string, version: number) => ({ data: { payload: { text, voice: false }, version, projectId, topicId } })

  expect((await (await mine.get(url)).json()).draft).toBeNull()
  const created = await mine.put(url, body('first', 0))
  expect(created.status()).toBe(200)
  expect((await created.json()).draft.version).toBe(1)
  const stale = await mine.put(url, body('from the other tab', 0))
  expect(stale.status()).toBe(409)
  const staleBody = await stale.json()
  expect(staleBody.error.details.code).toBe('STALE_VERSION')
  expect(staleBody.error.details.draft.payload.text).toBe('first')
  const saved = await mine.put(url, body('second', 1))
  expect((await saved.json()).draft.version).toBe(2)
  expect((await (await mine.get(url)).json()).draft.payload).toEqual({ text: 'second', voice: false })

  // Bad input: wrong shape, too large, unknown surface.
  expect((await mine.put(url, { data: { payload: { nope: 1 }, version: 2, projectId, topicId } })).status()).toBe(400)
  expect((await mine.put(url, body('x'.repeat(20_000), 2))).status()).toBe(413)
  expect((await mine.get('/api/drafts?surface=bogus&key=a')).status()).toBe(400)

  // Another signed-in user sees nothing, cannot write into this project, and cannot delete.
  const other = await request.newContext({ baseURL })
  await signInApi(other, OTHER_EMAIL)
  expect((await (await other.get(url)).json()).draft).toBeNull()
  expect((await other.put(url, body('forged', 0))).status()).toBe(404)
  await other.delete(url)
  expect((await (await mine.get(url)).json()).draft.version).toBe(2)

  // Signed out: 401.
  const anon = await request.newContext({ baseURL })
  expect((await anon.get(url)).status()).toBe(401)

  expect((await mine.delete(url)).status()).toBe(200)
  expect((await mine.delete(url)).status()).toBe(200)
  expect((await (await mine.get(url)).json()).draft).toBeNull()
  await Promise.all([mine.dispose(), other.dispose(), anon.dispose()])
})
