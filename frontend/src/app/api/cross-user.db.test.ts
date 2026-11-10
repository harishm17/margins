/**
 * One student cannot reach another student's rows through any route (SEC-L1).
 *
 * Student A owns a course with a unit, topic, file, conversation, exam, submissions, review session and so on. Student B
 * calls every route that has an id in its path with A's ids and must get 404, the same answer as for an id that does not
 * exist. A route.ts with a dynamic segment that is not understood here fails the enumeration test, so a new route cannot
 * ship unchecked. Runs against a migrated Postgres (DATABASE_URL); skipped without one.
 */
import test, { after, before } from 'node:test'
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
  | 'project'
  | 'topic'
  | 'unit'
  | 'material'
  | 'thread'
  | 'exam'
  | 'examSubmission'
  | 'quizSubmission'
  | 'reviewSession'
  | 'edge'
  | 'job'
  | 'concept'
  | 'claim'
  | 'chunk'
  | 'message'
  | 'requestId'
  | 'note'
  | 'recallAttempt'
  | 'quizSet'
  | 'warmupSession'
  | 'voiceSession',
  string
>

/** Student B owns a course of their own, which the second section names in the path while A's ids ride in the body or query. */
type Mine = Record<'project' | 'topic' | 'claimsTopic', string>

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
  'DELETE projects/[projectId]/removed-topic-notes': '?id=n1',
  'GET projects/[projectId]/review-sessions': '?active=1',
  'GET topics/[topicId]/item-sessions': '?kind=warmup',
  'GET topics/[topicId]/reader-checks': '?claimId=c1',
}

let prisma: Prisma
let available = false
let world: World
let mine: Mine
let userA = ''
let userB = ''

/** Calls that left for the AI service (other than the status read every model route starts with) during a case. */
const outgoing: string[] = []
const realFetch = globalThis.fetch
let addedSpeechKey = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  const { setTestSession } = await import('@/lib/auth/get-session')
  available = await prisma.$queryRaw`SELECT 1 FROM item_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
  if (!available) return
  // A route that would call the model must be refused by ownership first. A call that leaves is recorded and refused
  // at once, so a missing check fails a test and does not hang it.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/status/ai')) return Response.json({ available: true })
    outgoing.push(url)
    throw new Error(`the test refuses to call ${url}`)
  }) as typeof fetch
  // speech-token answers 503 before it looks at the session unless a provider has a key; the fetch above refuses the grant.
  if (!process.env.DEEPGRAM_API_KEY) {
    process.env.DEEPGRAM_API_KEY = 'test-key-not-used'
    addedSpeechKey = true
  }
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
  const chunk = await prisma.materialChunk.create({ data: { materialId: material.id, chunkText: 'A private passage.', chunkIndex: 0 } })
  const claim = await prisma.conceptClaim.create({
    data: { conceptId: c1.id, text: 'A private claim.', quote: 'A private passage.', materialId: material.id, chunkId: chunk.id, orderIndex: 0 },
  })
  const requestId = crypto.randomUUID()
  const message = await prisma.chatMessage.create({ data: { threadId: thread.id, role: 'assistant', content: 'A private answer.', tutor: {} } })
  await prisma.chatMessage.create({ data: { threadId: thread.id, role: 'user', content: 'A private question.', clientRequestId: requestId } })
  const note = await prisma.marginNote.create({
    data: {
      userId: a.id,
      projectId: topic.projectId,
      topicId: topic.id,
      materialId: material.id,
      chunkId: chunk.id,
      kind: 'question',
      text: 'A private note.',
      reply: { checkQuestion: 'A private check?' },
    },
  })
  const recallAttempt = await prisma.recallAttempt.create({
    data: { userId: a.id, topicId: topic.id, kind: 'recall', promptText: 'p', answerText: 'A private answer.', mode: 'text', result: {} },
  })
  const quizSet = await prisma.topicQuiz.create({ data: { topicId: topic.id, questions: [] } })
  const warmupSession = await prisma.itemSession.create({
    data: { userId: a.id, projectId: project.id, kind: 'warmup', topicIds: [topic.id], items: [] },
  })
  const voiceSession = await prisma.voiceDrillSession.create({
    data: { userId: a.id, projectId: project.id, topicId: topic.id, questionSet: [], metrics: { entries: [] } },
  })
  await prisma.studyDraft.create({
    data: {
      userId: a.id,
      projectId: project.id,
      topicId: topic.id,
      surface: 'recall',
      scopeKey: `${topic.id}:card`,
      payload: { text: 'A private draft.', voice: false },
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  // B's own course. B owns a project and two topics (one with an idea and a claim), so every path check passes and only
  // the foreign id in the body or query is on trial.
  const bProject = await prisma.project.create({ data: { userId: b.id, name: 'B course' } })
  const bTopic = await prisma.topic.create({ data: { projectId: bProject.id, name: 'BT', orderIndex: 0, userConfirmed: true } })
  const bClaimsTopic = await prisma.topic.create({ data: { projectId: bProject.id, name: 'BT2', orderIndex: 1, userConfirmed: true } })
  const bMaterial = await prisma.material.create({
    data: { projectId: bProject.id, category: 'lecture_notes', filename: 'b.pdf', gcsPath: `x/b-${stamp}.pdf`, sizeBytes: BigInt(10) },
  })
  const bConcept = await prisma.concept.create({
    data: { projectId: bProject.id, topicId: bClaimsTopic.id, name: 'BC', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  await prisma.conceptClaim.create({ data: { conceptId: bConcept.id, text: 'B claim.', quote: 'B claim.', materialId: bMaterial.id, orderIndex: 0 } })
  mine = { project: bProject.id, topic: bTopic.id, claimsTopic: bClaimsTopic.id }
  userA = a.id
  userB = b.id
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
    concept: c1.id,
    claim: claim.id,
    chunk: chunk.id,
    message: message.id,
    requestId,
    note: note.id,
    recallAttempt: recallAttempt.id,
    quizSet: quizSet.id,
    warmupSession: warmupSession.id,
    voiceSession: voiceSession.id,
  }
  setTestSession({ user: { id: b.id, email: b.email, name: null } })
})

after(() => {
  globalThis.fetch = realFetch
  if (addedSpeechKey) delete process.env.DEEPGRAM_API_KEY
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

/**
 * The other half of SEC-L1: B names B's own course in the path and A's ids in the body or the query (the original hole
 * was a body topicId). Each case is one field of one route. The answer is 404, the same as for an id that does not
 * exist, unless the route answers a foreign id the way it answers an unknown one with another status. That case names
 * the status and why it is safe, and the test proves it: the response holds nothing of A's, no row of A's or B's
 * changed, and nothing left for the AI service.
 */
type Call = {
  body?: unknown
  /** The query string, with its "?". */
  query?: string
  /** Path segments that are not B's plain project and topic. */
  params?: Record<string, string>
  /** 404 unless the route answers an unknown id differently. */
  status?: number
  /** For a status other than 404: what the response must hold. */
  safe?: (body: Record<string, unknown>) => void
}

const A = () => world
const B = () => mine
const draft = (projectId: string, topicId: string | null, key: string) => ({
  body: { payload: { text: 'x', voice: false }, version: 0, projectId, topicId },
  query: `?surface=recall&key=${key}`,
})
const exam = { totalQuestions: 10, durationMinutes: 30, difficultyLevel: 'medium' }

const FOREIGN: Record<string, () => Record<string, Call>> = {
  'POST voice/session': () => ({
    'projectId: A course': { body: { projectId: A().project, topicId: A().topic } },
    'topicId: A topic in B course': { body: { projectId: B().project, topicId: A().topic } },
    // Not a 404: the idea must be an active one of the topic, else it is ignored and the coach picks. The session is B's.
    'conceptId: A idea on a teach-back': {
      body: { projectId: B().project, topicId: B().claimsTopic, style: 'teach_back', conceptId: A().concept },
      status: 200,
      safe: (body) => assert.equal(typeof body.sessionId, 'string'),
    },
  }),
  'PATCH voice/session': () => ({ 'sessionId: A call': { body: { sessionId: A().voiceSession, status: 'ended', heartbeat: true } } }),
  'POST voice/turn': () => ({ 'sessionId: A call': { body: { sessionId: A().voiceSession, utterance: 'hi' } } }),
  'POST voice/metrics': () => ({ 'sessionId: A call': { body: { sessionId: A().voiceSession, entry: {} } } }),
  'POST voice/speech-token': () => ({ 'sessionId: A call': { body: { sessionId: A().voiceSession } } }),
  'GET voice/drill-pack': () => ({
    'projectId: A course': { query: `?projectId=${A().project}&topicId=${A().topic}` },
    // Not a 404: the question set is read through the topic's owner, so a topic of A's gives B no questions.
    'topicId: A topic in B course': {
      query: `?projectId=${B().project}&topicId=${A().topic}`,
      status: 200,
      safe: (body) => assert.equal(body.questionCount, 0),
    },
  }),
  'POST projects/[projectId]/chat': () => ({
    'topicId: A topic': { body: { question: 'Why?', topicId: A().topic } },
    'threadId: A conversation': { body: { question: 'Why?', threadId: A().thread } },
    'conceptId: A idea': { body: { question: 'Why?', conceptId: A().concept } },
  }),
  // Not a 404: the lookup is scoped to B's conversations in B's course, so the id A sent a question with finds none.
  'GET projects/[projectId]/chat/threads': () => ({
    'requestId: id A sent a question with': { query: `?requestId=${A().requestId}`, status: 200, safe: (body) => assert.equal(body.thread, null) },
  }),
  'POST projects/[projectId]/review-sessions': () => ({
    'topicId: A topic': { body: { topicId: A().topic } },
    'conceptId: A idea': { body: { conceptId: A().concept } },
    'examSubmissionId: A attempt': { body: { examSubmissionId: A().examSubmission } },
  }),
  'POST projects/[projectId]/topics': () => ({ 'unitId: A unit': { body: { name: 'New', unitId: A().unit } } }),
  'PATCH topics/[topicId]': () => ({
    'unitId: A unit': { body: { unitId: A().unit } },
    // Not a 404: prerequisites are cleaned against B's own course, so A's topic is left out.
    'prerequisiteIds: A topic': {
      body: { prerequisiteIds: [A().topic] },
      status: 200,
      safe: (body) => assert.deepEqual((body.topic as { prerequisiteIds: string[] }).prerequisiteIds, []),
    },
  }),
  // Not a 404: a topic that is not in the course answers 400 whether it is A's or does not exist. No job or exam is made.
  'POST projects/[projectId]/generate-exam': () => ({
    'topicIds: A topic': { body: { topicIds: [A().topic], ...exam }, status: 400 },
    'topicIds: B topic and A topic': { body: { topicIds: [B().topic, A().topic], ...exam }, status: 400 },
  }),
  'POST projects/[projectId]/topics/merge': () => ({
    'sourceTopicId: A topic': { body: { sourceTopicId: A().topic, targetTopicId: B().topic } },
    'targetTopicId: A topic': { body: { sourceTopicId: B().topic, targetTopicId: A().topic } },
  }),
  'PUT drafts': () => ({
    'projectId: A course': draft(A().project, B().topic, `${B().topic}:card`),
    'topicId: A topic in B course': draft(B().project, A().topic, `${A().topic}:card2`),
  }),
  // Not a 404: a draft is read by its owner and key, so B finds none of A's.
  'GET drafts': () => ({
    'key: A topic slot': { query: `?surface=recall&key=${A().topic}:card`, status: 200, safe: (body) => assert.equal(body.draft, null) },
  }),
  'POST ask-checks': () => ({ 'messageId: A answer': { body: { messageId: A().message, grade: 'got_it' } } }),
  'GET ask-checks': () => ({ 'messageId: A answer': { query: `?messageId=${A().message}` } }),
  'POST ask-checks/reveal': () => ({ 'messageId: A answer': { body: { messageId: A().message, attempt: 'my answer' } } }),
  'POST topics/[topicId]/margin-notes': () => ({ 'chunkId: A passage': { body: { chunkId: A().chunk, text: 'note' } } }),
  'DELETE topics/[topicId]/margin-notes': () => ({ 'id: A note': { query: `?id=${A().note}` } }),
  'DELETE projects/[projectId]/removed-topic-notes': () => ({ 'id: A note': { query: `?id=${A().note}` } }),
  'POST topics/[topicId]/reader-explain': () => ({
    'chunkId: A passage': { body: { chunkId: A().chunk, cantParse: true } },
    'noteId: A question': { body: { noteId: A().note, answer: 'my answer' } },
  }),
  'POST topics/[topicId]/reader-checks': () => ({ 'claimId: A claim': { body: { claimId: A().claim, grade: 'got_it' } } }),
  'GET topics/[topicId]/reader-checks': () => ({
    'claimId: A claim': { query: `?claimId=${A().claim}` },
    // Not a 404: the passages are read through B's topic, which holds none of A's claims.
    'conceptId: A idea': { query: `?conceptId=${A().concept}`, status: 200, safe: (body) => assert.deepEqual(body.chunkIds, []) },
  }),
  // Not a 404: ideas that are not in B's course are dropped, so no evidence is written.
  'POST topics/[topicId]/explainer': () => ({
    'conceptIds: A idea': {
      body: { action: 'section_viewed', kind: 'gap_explainer', conceptIds: [A().concept] },
      status: 200,
      safe: (body) => assert.equal(body.recorded, 0),
    },
  }),
  // Not a 404: the idea is looked up inside B's topic, so its name is not given.
  'GET topics/[topicId]/explainer': () => ({
    'concept: A idea': { query: `?concept=${A().concept}`, status: 200, safe: (body) => assert.equal(body.conceptName, null) },
  }),
  'POST topics/[topicId]/explainer-checks': () => ({
    'conceptId: A idea': { body: { question: 'q', grade: 'got_it', conceptId: A().concept } },
    'conceptIds: A idea': { body: { question: 'q', grade: 'got_it', conceptIds: [A().concept] } },
  }),
  'POST topics/[topicId]/instruction': () => ({ 'conceptIds: A idea': { body: { kind: 'pointer', conceptIds: [A().concept], ref: 'r' } } }),
  // Not a 404: the idea is not one of B's topic, so there is nothing to grade. Nothing is stored or sent.
  'POST topics/[topicId]/recall': () => ({
    'conceptId: A idea on a teach-back': {
      params: { topicId: B().claimsTopic },
      body: { kind: 'teach_back', conceptId: A().concept, answer: 'my answer' },
      status: 409,
      safe: (body) => assert.ok(JSON.stringify(body).includes('RECALL_NOT_READY')),
    },
  }),
  'PATCH topics/[topicId]/recall': () => ({ 'attemptId: A answer': { body: { attemptId: A().recallAttempt } } }),
  'PATCH topics/[topicId]/item-sessions': () => ({
    'sessionId: A warm-up': { body: { sessionId: A().warmupSession, index: 0, answer: 'x' } },
    'sessionId: A review': { body: { sessionId: A().reviewSession, index: 0, answer: 'x' } },
  }),
  // Not a 404: attempts are read by their owner and topic, so B sees none of A's.
  'GET topics/[topicId]/quiz-attempts': () => ({
    'quizSetId: A quiz': { query: `?quizSetId=${A().quizSet}`, status: 200, safe: (body) => assert.deepEqual(body.attempts, []) },
  }),
  'POST topics/[topicId]/quiz-attempts': () => ({ 'quizSetId: A quiz': { body: { answers: { '0': 'x' }, quizSetId: A().quizSet } } }),
  // Not a 404: jobs are listed for their owner, so B sees none of A's.
  'GET jobs': () => ({
    'projectId: A course': { query: `?active=1&projectId=${A().project}`, status: 200, safe: (body) => assert.deepEqual(body.jobs, []) },
  }),
}

/** Everything of A's and B's that a stray write would change, as one string. */
async function snapshot(): Promise<string> {
  const users = { in: [userA, userB] }
  const projects = { in: [world.project, mine.project] }
  return JSON.stringify([
    await prisma.evidenceEvent.count({ where: { userId: users } }),
    await prisma.marginNote.count({ where: { userId: users } }),
    await prisma.recallAttempt.count({ where: { userId: users } }),
    await prisma.studyDraft.count({ where: { userId: users } }),
    await prisma.itemSession.count({ where: { userId: users } }),
    await prisma.chatThread.count({ where: { userId: users } }),
    await prisma.chatMessage.count({ where: { thread: { userId: users } } }),
    await prisma.processingJob.count({ where: { userId: users } }),
    await prisma.quizAttempt.count({ where: { userId: users } }),
    await prisma.quizSubmission.count({ where: { userId: users } }),
    await prisma.examSubmission.count({ where: { userId: users } }),
    await prisma.sampleExam.count({ where: { projectId: projects } }),
    await prisma.topic.findMany({ where: { projectId: projects }, orderBy: { id: 'asc' } }),
    await prisma.unit.findMany({ where: { projectId: projects }, orderBy: { id: 'asc' } }),
    await prisma.concept.count({ where: { projectId: projects } }),
    await prisma.voiceDrillSession.findMany({ where: { userId: userA }, orderBy: { id: 'asc' } }),
    await prisma.voiceDrillSession.count({ where: { projectId: world.project } }),
    await prisma.studyDraft.findMany({ where: { userId: userA }, orderBy: { id: 'asc' } }),
    await prisma.marginNote.findMany({ where: { userId: userA }, orderBy: { id: 'asc' } }),
  ])
}

for (const [key, build] of Object.entries(FOREIGN)) {
  const [method, route] = key.split(' ') as [(typeof METHODS)[number], string]
  test(`another student's ids in the body or query of ${key} are refused`, async (t) => {
    if (!available) return t.skip('no migrated test database')
    const loaded = (await import(`./${route}/route`)) as Record<string, unknown>
    assert.equal(typeof loaded[method], 'function', `${route} exports no ${method}`)
    // What identifies A's rows: none of it may come back to B.
    const markers = [...Object.values(world), 'A course', 'A private']
    for (const [field, call] of Object.entries(build())) {
      const params: Record<string, string> = {}
      for (const segment of route.split('/')) {
        const name = /^\[(\w+)\]$/.exec(segment)?.[1]
        if (name) params[name] = name === 'projectId' ? mine.project : mine.topic
      }
      Object.assign(params, call.params)
      const request = new NextRequest(`http://localhost/api/${route}${call.query ?? ''}`, {
        method,
        ...(call.body !== undefined ? { body: JSON.stringify(call.body), headers: { 'content-type': 'application/json' } } : {}),
      })
      const before = await snapshot()
      outgoing.length = 0
      const response = await (loaded[method] as Handler)(request, { params: Promise.resolve(params) })
      const text = await response.text()
      const label = `${key} ${field}`
      assert.equal(response.status, call.status ?? 404, `${label} answered ${response.status}: ${text.slice(0, 200)}`)
      for (const marker of markers) assert.ok(!text.includes(marker), `${label} sent back something of A's (${marker})`)
      assert.equal(await snapshot(), before, `${label} changed rows`)
      assert.deepEqual(outgoing, [], `${label} reached the AI service`)
      call.safe?.(text ? (JSON.parse(text) as Record<string, unknown>) : {})
    }
  })
}
