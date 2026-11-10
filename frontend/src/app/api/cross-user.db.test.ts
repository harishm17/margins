/**
 * One student cannot reach another student's rows through any route (SEC-L1).
 *
 * Student A owns a course with a unit, topic, file, conversation, exam, submissions, review session and so on. Student B
 * calls every route that has an id in its path with A's ids and must get 404, the same answer as for an id that does not
 * exist. A route.ts with a dynamic segment that is not understood here fails the enumeration test, so a new route cannot
 * ship unchecked. Runs against a migrated Postgres (DATABASE_URL); skipped without one.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { NextRequest } from 'next/server'

type Prisma = typeof import('@/lib/db/prisma').prisma
type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>

const API = join(process.cwd(), 'src', 'app', 'api')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return routeFiles(path)
    return name === 'route.ts' ? [path] : []
  })
}

/** Every route.ts with a dynamic segment, as its path under src/app/api (e.g. "topics/[topicId]/recall"). */
function dynamicRoutes(): string[] {
  return routeFiles(API)
    .map((file) => relative(API, file).split(sep).slice(0, -1).join('/'))
    .filter((route) => route.includes('['))
    .sort()
}

/** Routes with a dynamic segment that are not about a student's rows. */
const NOT_ROWS = new Set(['auth/[...nextauth]'])

type World = Record<
  'project' | 'topic' | 'unit' | 'material' | 'thread' | 'exam' | 'examSubmission' | 'quizSubmission' | 'reviewSession' | 'edge' | 'job',
  string
>

/** Which of A's ids fills each dynamic segment. */
const NAMES: Record<string, keyof World> = {
  projectId: 'project',
  topicId: 'topic',
  unitId: 'unit',
  materialId: 'material',
  threadId: 'thread',
  examId: 'exam',
  edgeId: 'edge',
  jobId: 'job',
  sessionId: 'reviewSession',
}
/** A submission id is an exam submission under exams/ and a quiz submission under topics/. */
const SUBMISSION: Record<string, keyof World> = { exams: 'examSubmission', topics: 'quizSubmission' }

/** Bodies for routes that read one before they look at the id, by "METHOD route"; the default is an empty object. */
const uuid = () => crypto.randomUUID()
const BODIES: Record<string, Record<string, unknown>> = {
  'POST topics/[topicId]/margin-notes': { chunkId: 'c1', text: 'note' },
  'PATCH concept-edges/[edgeId]': { status: 'confirmed' },
  'PATCH materials/[materialId]': { role: 'content' },
  'POST projects/[projectId]/chat': { question: 'Why?', clientRequestId: uuid() },
  'POST review-sessions/[sessionId]/answer': { index: 0, answer: 'x' },
  'POST review-sessions/[sessionId]/skip': { index: 0 },
  'POST topics/[topicId]/confidence': { source: 'quiz', value: 3 },
  'POST topics/[topicId]/explainer': { action: 'viewed' },
  'POST topics/[topicId]/explainer-checks': { question: 'q', grade: 'got_it' },
  'POST topics/[topicId]/instruction': { kind: 'pointer', conceptIds: ['c1'], ref: 'r' },
  'POST topics/[topicId]/reader-explain': { chunkId: 'c1' },
  'POST topics/[topicId]/recall': { kind: 'recall', answer: 'x' },
  'PATCH topics/[topicId]/recall': { attemptId: 'a1' },
  'POST projects/[projectId]/topics/merge': { sourceTopicId: 't1', targetTopicId: 't2' },
  'POST topics/[topicId]/item-sessions': { kind: 'warmup' },
  'PATCH topics/[topicId]/item-sessions': { sessionId: 's1', index: 0, answer: 'x' },
  'POST topics/[topicId]/reader-checks': { claimId: 'c1', grade: 'got_it' },
}
/** Query strings for routes that ask for one on GET or DELETE. */
const QUERIES: Record<string, string> = {
  'DELETE topics/[topicId]/margin-notes': '?id=n1',
  'GET projects/[projectId]/review-sessions': '?active=1',
  'GET topics/[topicId]/item-sessions': '?kind=warmup',
  'GET topics/[topicId]/reader-checks': '?claimId=c1',
}

let prisma: Prisma
let available = false
let world: World

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  const { setTestSession } = await import('@/lib/auth/get-session')
  available = await prisma.$queryRaw`SELECT 1 FROM item_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
  if (!available) return
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const a = await prisma.user.create({ data: { email: `cu-a-${stamp}@example.com` } })
  const b = await prisma.user.create({ data: { email: `cu-b-${stamp}@example.com` } })
  const project = await prisma.project.create({ data: { userId: a.id, name: 'A course' } })
  const unit = await prisma.unit.create({ data: { projectId: project.id, title: 'U', orderIndex: 0 } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, unitId: unit.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const other = await prisma.topic.create({ data: { projectId: project.id, name: 'T2', orderIndex: 1, userConfirmed: true } })
  const material = await prisma.material.create({
    data: { projectId: project.id, category: 'lecture_notes', filename: 'a.pdf', gcsPath: `x/${stamp}.pdf`, sizeBytes: BigInt(10) },
  })
  const thread = await prisma.chatThread.create({ data: { userId: a.id, projectId: project.id, title: 'Q' } })
  const exam = await prisma.sampleExam.create({
    data: { projectId: project.id, name: 'E', questions: [], durationMinutes: 30, difficultyLevel: 'medium', topicsCovered: [] },
  })
  const examSubmission = await prisma.examSubmission.create({ data: { sampleExamId: exam.id, userId: a.id, answers: {} } })
  const quizSubmission = await prisma.quizSubmission.create({
    data: { userId: a.id, topicId: topic.id, answers: {}, questions: [], answersHash: stamp },
  })
  const reviewSession = await prisma.itemSession.create({
    data: { userId: a.id, projectId: project.id, kind: 'review', topicIds: [topic.id], items: [] },
  })
  const c1 = await prisma.concept.create({
    data: { projectId: project.id, topicId: topic.id, name: 'C1', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  const c2 = await prisma.concept.create({
    data: { projectId: project.id, topicId: other.id, name: 'C2', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  const edge = await prisma.conceptEdge.create({
    data: { projectId: project.id, sourceId: c1.id, targetId: c2.id, type: 'prerequisite', weight: 1, confidence: 0.9 },
  })
  const job = await prisma.processingJob.create({ data: { userId: a.id, projectId: project.id, jobType: 'generate_content' } })
  world = {
    project: project.id,
    topic: topic.id,
    unit: unit.id,
    material: material.id,
    thread: thread.id,
    exam: exam.id,
    examSubmission: examSubmission.id,
    quizSubmission: quizSubmission.id,
    reviewSession: reviewSession.id,
    edge: edge.id,
    job: job.id,
  }
  setTestSession({ user: { id: b.id, email: b.email, name: null } })
})

function idFor(segment: string, route: string): string | undefined {
  const name = /^\[(\w+)\]$/.exec(segment)?.[1]
  if (!name) return undefined
  const key = name === 'submissionId' ? SUBMISSION[route.split('/')[0]] : NAMES[name]
  return key ? world[key] : undefined
}

const covered = dynamicRoutes().filter((route) => !NOT_ROWS.has(route))

test('every route with an id in its path is understood here', () => {
  assert.ok(covered.length > 40, 'the routes were not found')
  for (const route of covered) {
    for (const segment of route.split('/').filter((s) => s.startsWith('['))) {
      const name = /^\[(\w+)\]$/.exec(segment)?.[1] ?? ''
      assert.ok(name === 'submissionId' || name in NAMES, `${route}: no id is known for ${segment}; add it to NAMES`)
    }
  }
})

for (const route of covered) {
  test(`another student gets 404 for A's ids on ${route}`, async (t) => {
    if (!available) return t.skip('no migrated test database')
    const loaded = (await import(`./${route}/route`)) as Record<string, unknown>
    const methods = METHODS.filter((method) => typeof loaded[method] === 'function')
    assert.ok(methods.length > 0, `${route} exports no handler`)
    const params: Record<string, string> = {}
    for (const segment of route.split('/')) {
      const id = idFor(segment, route)
      if (id) params[/^\[(\w+)\]$/.exec(segment)![1]] = id
    }
    for (const method of methods) {
      const hasBody = method !== 'GET' && method !== 'DELETE'
      const request = new NextRequest(`http://localhost/api/${route}${QUERIES[`${method} ${route}`] ?? ''}`, {
        method,
        ...(hasBody ? { body: JSON.stringify(BODIES[`${method} ${route}`] ?? {}), headers: { 'content-type': 'application/json' } } : {}),
      })
      const response = await (loaded[method] as Handler)(request, { params: Promise.resolve(params) })
      assert.equal(response.status, 404, `${method} ${route} answered ${response.status} to another student's ids`)
    }
  })
}
