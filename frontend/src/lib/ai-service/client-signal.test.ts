import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { callSignal, withClientSignal } from './client-signal'

const SRC = path.resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

test('a call made inside a wrapped route stops when the browser leaves', async () => {
  const browser = new AbortController()
  const request = new Request('http://localhost/x', { signal: browser.signal })
  let seen: AbortSignal | undefined
  await withClientSignal(async (_request: Request) => {
    seen = callSignal(60_000)
  })(request)
  assert.equal(seen?.aborted, false)
  browser.abort()
  assert.equal(seen?.aborted, true)
})

test('a call made outside a route has only its own timeout', () => {
  const signal = callSignal(60_000)
  assert.equal(signal.aborted, false)
})

// Routes that reach the model, directly or through these libraries, must keep the client's signal.
const MODEL_LIBS = /lib\/ai-service\/(tutor|grading|recall)|lib\/voice\/(ai-turn|drill-pack)|lib\/chat\/server|practice-tutor|reader-server|review-session|warmup-session|voice\/tools/
// Routes that import those libraries but never start a model call.
const NO_MODEL_CALL = new Set([
  'app/api/projects/[projectId]/chat/threads/route.ts',
  'app/api/review-sessions/[sessionId]/route.ts',
  'app/api/review-sessions/[sessionId]/skip/route.ts',
])

test('every route that reaches the model wraps its handlers in withClientSignal', () => {
  const missing: string[] = []
  for (const file of walk(path.join(SRC, 'app/api')).filter((f) => f.endsWith('route.ts'))) {
    const rel = path.relative(SRC, file)
    const text = fs.readFileSync(file, 'utf8')
    if (!MODEL_LIBS.test(text) || NO_MODEL_CALL.has(rel)) continue
    if (!text.includes('withClientSignal(')) missing.push(rel)
  }
  assert.deepEqual(missing, [])
})

// Only these build their own signal for a fetch: they do not call the model on a student's behalf.
const OWN_SIGNAL_OK = new Set([
  'lib/tasks/dispatch.ts',
  'server/ai-status.ts',
  'lib/ai-service/exam-guard.ts',
  'lib/ai-service/client-signal.ts',
  'lib/voice/cloud-speech.ts',
  'lib/analytics/proxy.ts',
  'lib/analytics/capture.ts',
  'app/api/health/runtime/route.ts',
  'app/api/health/ready/route.ts',
  // Chat is the one model call a dropped request does not cancel: its answer is stored and shown after a Stop (chat/stream.ts).
  'lib/chat/server.ts',
])

test('AI-service clients take their signal from callSignal', () => {
  const offenders: string[] = []
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file)
    if (OWN_SIGNAL_OK.has(rel)) continue
    if (fs.readFileSync(file, 'utf8').includes('AbortSignal.timeout(')) offenders.push(rel)
  }
  assert.deepEqual(offenders, [])
})
