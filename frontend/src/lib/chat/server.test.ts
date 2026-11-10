import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { errorCodeFromResponse, HISTORY_MESSAGES, requestChatAnswer, toHistoryTurns } from './server'

describe('toHistoryTurns', () => {
  it('keeps the last messages, oldest first, and skips failure notes and blanks', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }))
    messages.push({ role: 'error', content: 'The AI service is busy.' }, { role: 'user', content: '   ' })
    const turns = toHistoryTurns(messages)
    assert.equal(turns.length, HISTORY_MESSAGES)
    assert.deepEqual(turns.map((t) => t.content), ['m4', 'm5', 'm6', 'm7', 'm8', 'm9'])
  })
})

describe('errorCodeFromResponse', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it('uses the AI service error code', async () => {
    assert.equal(await errorCodeFromResponse(json(429, { error_code: 'LLM_DAILY_BUDGET', detail: 'x' })), 'LLM_DAILY_BUDGET')
  })

  it('falls back by status when there is no code', async () => {
    assert.equal(await errorCodeFromResponse(new Response('<html>', { status: 502 })), 'CHAT_UNAVAILABLE')
    assert.equal(await errorCodeFromResponse(json(401, { detail: 'Unauthorized' })), 'CHAT_UNAVAILABLE')
    assert.equal(await errorCodeFromResponse(json(422, { detail: [] })), 'CHAT_FAILED')
  })
})

describe('requestChatAnswer', () => {
  it('sends the thread tutor state when there is one, and nothing otherwise', async () => {
    const bodies: Record<string, unknown>[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('{}')
    }) as typeof fetch
    try {
      const base = { projectId: 'p', userId: 'u', question: 'q', history: [] }
      await requestChatAnswer({ ...base, tutor: { rung: 2, final_allowed: false } })
      await requestChatAnswer(base)
    } finally {
      globalThis.fetch = realFetch
    }
    assert.deepEqual(bodies[0].tutor, { rung: 2, final_allowed: false })
    assert.equal('tutor' in bodies[1], false)
  })
})
