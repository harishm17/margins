/**
 * PF0, the speed baseline (src/lib/perf/baseline.ts makes the tables). Run it against a production build on a copy of
 * a real course's database, the copy because the stack's AI service sends any pending job in its database:
 *
 *   createdb -T <course db> <copy>, then migrate the copy (npx prisma migrate deploy)
 *   E2E_WEB_PORT=3470 E2E_AI_PORT=8470 E2E_RUN_DIR=/tmp/margins-pf0 DATABASE_URL=<copy> ../scripts/e2e-stack.sh start
 *   cd frontend && DATABASE_URL=<copy> npx tsx scripts/perf-baseline.ts --base http://localhost:3470 --email <student>@example.com
 *
 * It signs in with the test sign-in, takes the student's latest course and a topic of it with notes and practice, and for
 * the landing page, course home, topic Read, a review session and Ask: the server time (time to the response headers, the
 * first request apart, then the median of --server-runs more) and Lighthouse on a phone profile with simulated throttling
 * (the median of --runs; the `lighthouse` CLI on PATH). It also measures the compressed JavaScript of the build in .next.
 * With --live it sends three Ask questions and, after one checked answer, two practice-tutor questions and times their first words: that calls the
 * real model (a few cents), so the stack's AI service must run with E2E_LLM_PROVIDER=anthropic.
 * Course text is never printed: pages are named by their kind, not their title.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import { prisma } from '../src/lib/db/prisma'
import { parsePracticeProblems } from '../src/features/topic/content'
import {
  firstWordsMs,
  formatBaseline,
  lighthouseFigures,
  medianFigures,
  serverTimes,
  type BundleFigures,
  type LiveTiming,
  type PageFigures,
} from '../src/lib/perf/baseline'

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}

const BASE = option('base', 'http://localhost:3470').replace(/\/$/, '')
const EMAIL = option('email', '')
const RUNS = Number(option('runs', '3'))
const SERVER_RUNS = Number(option('server-runs', '6'))
const LIVE = process.argv.includes('--live')
const SKIP_LIGHTHOUSE = process.argv.includes('--no-lighthouse')

async function signIn(): Promise<string> {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    await context.addCookies([{ name: 'margins_tz', value: encodeURIComponent('America/Los_Angeles'), domain: new URL(BASE).hostname, path: '/' }])
    const page = await context.newPage()
    await page.goto(`${BASE}/login`)
    const form = page.getByRole('form', { name: 'Test sign-in' })
    await form.getByLabel('Email').fill(EMAIL)
    await form.getByRole('button', { name: 'Test sign-in' }).click()
    await page.waitForURL(/\/home$/, { timeout: 60_000 })
    return (await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  } finally {
    await browser.close()
  }
}

/** The student's latest course, and its first topic (in course order) that has notes and practice problems. */
async function findCourse() {
  const rows = await prisma.$queryRaw<{ project_id: string; topic_id: string; practice: unknown }[]>`
    SELECT p.id AS project_id, t.id AS topic_id, ic.content_data AS practice
    FROM users u
    JOIN projects p ON p.user_id = u.id
    JOIN topics t ON t.project_id = p.id
    JOIN topic_content sn ON sn.topic_id = t.id AND sn.content_type = 'section_notes'
    JOIN topic_content ic ON ic.topic_id = t.id AND ic.content_type = 'interactive_examples'
    WHERE u.email = ${EMAIL}
    ORDER BY p.created_at DESC, t.order_index
    LIMIT 1`
  if (!rows[0]) throw new Error(`no course of ${EMAIL} has a topic with notes and practice problems`)
  // The title the tutor checks the request against, read with the page's own parser.
  const problems = parsePracticeProblems(rows[0].practice, new Date().toISOString())?.items ?? []
  return { projectId: rows[0].project_id, topicId: rows[0].topic_id, problemTitle: problems[0]?.title ?? '' }
}

/** A kept-alive connection the server closed while Lighthouse ran fails at once; the request is sent again, and timed again. */
async function timedGet(path: string, cookie: string | null): Promise<{ response: Response; ms: number }> {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now()
    try {
      const response = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
      return { response, ms: performance.now() - started }
    } catch (error) {
      if (attempt > 0) throw error
    }
  }
}

async function timeServer(path: string, cookie: string | null): Promise<number[]> {
  const times: number[] = []
  for (let run = 0; run <= SERVER_RUNS; run++) {
    const { response, ms } = await timedGet(path, cookie)
    times.push(ms)
    await response.arrayBuffer()
    if (response.status !== 200) throw new Error(`${path} answered ${response.status}, not 200`)
  }
  return times
}

function lighthouse(path: string, cookie: string | null) {
  const args = [
    `${BASE}${path}`,
    '--only-categories=performance',
    '--output=json',
    '--output-path=stdout',
    '--quiet',
    '--chrome-flags=--headless=new --no-sandbox',
    ...(cookie ? [`--extra-headers=${JSON.stringify({ Cookie: cookie })}`] : []),
  ]
  const result = spawnSync('lighthouse', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`lighthouse failed on ${path}: ${result.stderr.slice(-400)}`)
  return lighthouseFigures(JSON.parse(result.stdout))
}

function bundle(): BundleFigures {
  const root = join(process.cwd(), '.next', 'static', 'chunks')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.js')) files.push(path)
    }
  }
  walk(root)
  let total = 0
  let markdown: number | null = null
  let markdownRaw = 0
  for (const file of files) {
    const source = readFileSync(file)
    const compressed = gzipSync(source).length
    total += compressed
    // The markdown renderer's chunk carries highlight.js's class prefix; the largest such chunk is the renderer.
    if (source.includes('hljs-') && source.length > markdownRaw) {
      markdownRaw = source.length
      markdown = compressed
    }
  }
  return { markdownChunkKb: markdown === null ? null : Number((markdown / 1024).toFixed(1)), clientJsKb: total / 1024, chunks: files.length }
}

async function askTiming(projectId: string, topicId: string, cookie: string, question: string): Promise<{ firstWordsMs: number | null; doneMs: number | null }> {
  const started = performance.now()
  const response = await fetch(`${BASE}/api/projects/${projectId}/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ question, topicId }),
  })
  if (!response.ok || !response.body) throw new Error(`Ask answered ${response.status}`)
  const events: { at: number; line: string }[] = []
  const decoder = new TextDecoder()
  let buffered = ''
  const reader = response.body.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    const at = performance.now()
    for (const line of lines) if (line.trim()) events.push({ at, line })
  }
  return firstWordsMs(started, events)
}

async function tutorEvent(topicId: string, problemTitle: string, cookie: string, event: Record<string, unknown>): Promise<number> {
  const started = performance.now()
  const response = await fetch(`${BASE}/api/topics/${topicId}/practice-tutor`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ problemIndex: 0, problemTitle, stepIndex: 0, ...event }),
  })
  const body = (await response.json().catch(() => null)) as { error?: { details?: { code?: string } } } | null
  if (!response.ok) throw new Error(`the practice tutor answered ${response.status} ${body?.error?.details?.code ?? ''}`)
  return performance.now() - started
}

async function main() {
  if (!EMAIL) throw new Error('--email is required (the student whose course is measured)')
  const cookie = await signIn()
  const { projectId, topicId, problemTitle } = await findCourse()
  const course = `/courses/${projectId}`
  const pages: { name: string; path: string; signedIn: boolean }[] = [
    { name: 'Landing', path: '/', signedIn: false },
    { name: 'Course home', path: course, signedIn: true },
    { name: 'Topic Read', path: `${course}/topics/${topicId}?view=read`, signedIn: true },
    { name: 'Review session', path: `${course}/review/session`, signedIn: true },
    { name: 'Ask', path: `${course}/ask`, signedIn: true },
  ]

  const figures: PageFigures[] = []
  for (const page of pages) {
    const auth = page.signedIn ? cookie : null
    const server = serverTimes(await timeServer(page.path, auth))
    const runs = SKIP_LIGHTHOUSE ? [] : Array.from({ length: RUNS }, () => lighthouse(page.path, auth))
    figures.push({ name: page.name, path: page.path, server, lighthouse: runs.length ? medianFigures(runs) : null, lighthouseRuns: runs.length })
    console.error(`measured ${page.name}`)
  }

  const live: LiveTiming[] = []
  if (LIVE) {
    const questions = ['What is the main idea of this topic?', 'Can you walk me through the key step with a small example?', 'What mistake do students often make here?']
    for (const [n, question] of questions.entries()) live.push({ name: `Ask, question ${n + 1}`, ...(await askTiming(projectId, topicId, cookie, question)) })
    // A question about the working needs a checked answer on the step first (no model call), as a student would have.
    await tutorEvent(topicId, problemTitle, cookie, { event: 'check', answer: 'not sure yet' })
    for (const [n, message] of ['Where do I start on this step?', 'What should I look at first?'].entries()) {
      const ms = await tutorEvent(topicId, problemTitle, cookie, { event: 'ask', message })
      live.push({ name: `Practice tutor, ask ${n + 1} (not streamed: the whole reply)`, firstWordsMs: ms, doneMs: ms })
    }
  }

  console.log(`Build ${readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim()} at ${BASE}; Lighthouse runs per page: ${SKIP_LIGHTHOUSE ? 0 : RUNS}; server runs per page: 1 + ${SERVER_RUNS}\n`)
  console.log(formatBaseline({ pages: figures, live, bundle: bundle() }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
