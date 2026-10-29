import path from 'node:path'
import { readFileSync } from 'node:fs'
import { request, type APIRequestContext } from '@playwright/test'
import { signInApi } from './auth'
import { withPrisma } from './db'

/**
 * The demo account and course the e2e specs share, written through the app's own API against the
 * mock AI service (so it is free and quick): "CS 161 Algorithms" with two uploaded files, four
 * confirmed topics with every kind of study content, a quiz attempt, one graded mock exam and one
 * chat answer, and a second, empty course that stays on the setup guide. Idempotent: each step
 * looks at what exists first. `global-setup.ts` runs it once per Playwright run.
 */
// An @example.com address: the only kind the test sign-in accepts (src/lib/auth/test-login.ts).
export const DEMO_EMAIL = 'demo@example.com'
const DEMO_NAME = 'Demo Student'
export const DEMO_COURSE = 'CS 161 Algorithms'
const DEMO_COURSE_DESCRIPTION = 'Midterm and final prep: sorting, graphs, hashing and dynamic programming.'
export const SETUP_COURSE = 'Organic Chemistry'

export const FIXTURES = path.join(__dirname, '..', 'fixtures')
export const FIXTURE_PDF = path.join(FIXTURES, 'algorithms.pdf')
export const FIXTURE_DOCX = path.join(FIXTURES, 'hashing.docx')

const FILES = [
  { file: FIXTURE_PDF, filename: 'algorithms.pdf', mime: 'application/pdf' },
  {
    file: FIXTURE_DOCX,
    filename: 'hashing.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
]

// The mock LLM invents placeholder topics that match nothing in the files, so no study content
// could be written from them. These match the sample files.
const TOPICS = [
  ['Sorting algorithms', 'Merge sort, quicksort and heapsort, with their running times and the comparison lower bound.'],
  ['Graph traversal', 'How breadth-first and depth-first search explore a graph, and when to use each.'],
  ['Dynamic programming', 'Optimal substructure, overlapping subproblems, and building solutions bottom up.'],
  ['Hash tables', 'Hash functions, collision resolution by chaining and open addressing, and load factor.'],
]

const MATH_TOPIC = 'Discrete random variables'

// The course structure: two units (with a week each) holding the four hand-made topics. The math
// topic stays outside every unit on purpose, so the demo course shows the "Topics" group too.
// Sources point at the sample files (algorithms.pdf has 4 pages and 4 chunks, hashing.docx has 3
// chunks and no pages), objectives hold math so the header's renderer is exercised.
export const UNITS = [
  { title: 'Sorting and graphs', weekLabel: 'Week 1' },
  { title: 'Dynamic programming and hashing', weekLabel: 'Week 2' },
]
const STRUCTURE: Record<
  string,
  { unit: number; objectives: string[]; minutes: number; after?: string; source: { file: string; pages?: [number, number]; chunks: [number, number] } }
> = {
  'Sorting algorithms': {
    unit: 0,
    objectives: [
      'trace merge sort and quicksort on a small array',
      'compare running times, such as $O(n \\log n)$ and $O(n^2)$',
      'explain why a comparison sort needs $\\Omega(n \\log n)$ comparisons',
    ],
    minutes: 35,
    source: { file: 'algorithms.pdf', pages: [1, 2], chunks: [0, 1] },
  },
  'Graph traversal': {
    unit: 0,
    objectives: ['run breadth-first and depth-first search by hand', 'choose between them for a given problem', 'find shortest paths in an unweighted graph'],
    minutes: 30,
    after: 'Sorting algorithms',
    source: { file: 'algorithms.pdf', pages: [3, 3], chunks: [2, 2] },
  },
  'Dynamic programming': {
    unit: 1,
    objectives: ['spot optimal substructure and overlapping subproblems', 'fill a table bottom up', 'recover the solution from the table'],
    minutes: 45,
    after: 'Graph traversal',
    source: { file: 'algorithms.pdf', pages: [4, 4], chunks: [3, 3] },
  },
  'Hash tables': {
    unit: 1,
    objectives: ['pick a hash function and handle collisions', 'compare chaining with open addressing', 'work out the load factor and its effect on speed'],
    minutes: 25,
    after: 'Sorting algorithms',
    source: { file: 'hashing.docx', chunks: [0, 2] },
  },
}

export type DemoIds = {
  course: string
  setupCourse: string
  /** The four topics with mock-LLM content. */
  topics: string[]
  /** A fifth topic holding real generated content full of math (fixtures/math-topic.json). */
  mathTopic: string
}

/** The ids `global-setup.ts` stored for this run. */
export function demoIds(): DemoIds {
  const raw = process.env.E2E_DEMO_IDS
  if (!raw) throw new Error('E2E_DEMO_IDS is not set: the demo seed (global-setup.ts) did not run')
  return JSON.parse(raw) as DemoIds
}

type Json = Record<string, any>

async function json(response: Awaited<ReturnType<APIRequestContext['get']>>, what: string): Promise<Json> {
  if (!response.ok()) throw new Error(`${what}: HTTP ${response.status()} ${(await response.text()).slice(0, 300)}`)
  const text = await response.text()
  return text ? JSON.parse(text) : {}
}

async function waitFor<T>(check: () => Promise<T | null | false>, what: string, timeoutMs: number, intervalMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting for ${what}`)
}


async function ensureCourse(api: APIRequestContext, name: string, description?: string): Promise<string> {
  const existing = await withPrisma((prisma) =>
    prisma.project.findFirst({ where: { name, user: { email: DEMO_EMAIL } }, select: { id: true } })
  )
  if (existing) return existing.id
  const body = await json(await api.post('/api/projects', { data: { name, description } }), `create course ${name}`)
  return body.project.id as string
}

const activeJobs = async (api: APIRequestContext, courseId: string, types?: string) =>
  ((await json(await api.get(`/api/jobs?active=1&projectId=${courseId}${types ? `&types=${types}` : ''}`), 'active jobs')).jobs ??
    []) as Json[]

const materials = async (api: APIRequestContext, courseId: string) =>
  (await json(await api.get(`/api/projects/${courseId}/materials`), 'materials')).materials as Json[]

const topics = async (api: APIRequestContext, courseId: string) =>
  (await json(await api.get(`/api/projects/${courseId}/topics`), 'topics')).topics as Json[]

async function ensureMaterials(api: APIRequestContext, courseId: string) {
  const present = new Set((await materials(api, courseId)).map((item) => item.filename))
  for (const { file, filename, mime } of FILES) {
    if (present.has(filename)) continue
    const response = await api.post(`/api/projects/${courseId}/materials?category=lecture_notes&filename=${filename}`, {
      data: readFileSync(file),
      headers: { 'content-type': mime },
    })
    await json(response, `upload ${filename}`)
  }
  await waitFor(
    async () => {
      const items = await materials(api, courseId)
      return items.length >= FILES.length && items.every((item) => item.validationStatus !== 'pending')
    },
    'materials to validate',
    300_000
  )
}

async function ensureTopics(api: APIRequestContext, courseId: string): Promise<Json[]> {
  if ((await topics(api, courseId)).length === 0) {
    // Extraction usually starts on its own once the last file is chunked; start it if it did not.
    await waitFor(
      async () => {
        if ((await topics(api, courseId)).length > 0) return true
        if ((await activeJobs(api, courseId, 'extract_topics,chunk_material')).length === 0) {
          await api.post(`/api/projects/${courseId}/extract-topics`)
        }
        return false
      },
      'topics to be found',
      300_000,
      3000
    )
  }
  let found = await topics(api, courseId)
  if (found.some((topic) => String(topic.name).endsWith('(mock)'))) {
    for (const topic of found.filter((item) => String(item.name).endsWith('(mock)'))) {
      await json(await api.delete(`/api/topics/${topic.id}`), 'delete mock topic')
    }
    for (const [name, description] of TOPICS) {
      await json(await api.post(`/api/projects/${courseId}/topics`, { data: { name, description } }), `create topic ${name}`)
    }
    found = await topics(api, courseId)
  }
  // Confirming also moves the course out of setup; hand-added topics are confirmed already, the course is not.
  await json(await api.post(`/api/projects/${courseId}/topics/confirm`), 'confirm topics')
  return topics(api, courseId)
}

/** Units, objectives, prerequisites, minutes and sources for the hand-made topics. Idempotent. */
async function ensureStructure(api: APIRequestContext, courseId: string) {
  // The mock plan wrote a unit per file; its topics are gone by now, so those units are empty.
  await withPrisma((prisma) => prisma.unit.deleteMany({ where: { projectId: courseId, title: { endsWith: '(mock)' } } }))
  const unitIds: string[] = []
  for (const unit of UNITS) {
    const existing = await withPrisma((prisma) =>
      prisma.unit.findFirst({ where: { projectId: courseId, title: unit.title }, select: { id: true } })
    )
    unitIds.push(
      existing?.id ??
        ((await json(await api.post(`/api/projects/${courseId}/units`, { data: unit }), `create unit ${unit.title}`)).unit.id as string)
    )
  }
  const all = await topics(api, courseId)
  const byName = new Map(all.map((topic) => [String(topic.name), topic.id as string]))
  const materialIds = new Map(
    (await materials(api, courseId)).map((item) => [String(item.filename), item.id as string])
  )
  for (const [name, plan] of Object.entries(STRUCTURE)) {
    const id = byName.get(name)
    if (!id) continue
    await json(
      await api.patch(`/api/topics/${id}`, {
        data: {
          unitId: unitIds[plan.unit],
          objectives: plan.objectives,
          estimatedMinutes: plan.minutes,
          prerequisiteIds: plan.after && byName.get(plan.after) ? [byName.get(plan.after)] : [],
        },
      }),
      `structure ${name}`
    )
    const materialId = materialIds.get(plan.source.file)
    if (!materialId) continue
    await withPrisma(async (prisma) => {
      if ((await prisma.topicSource.count({ where: { topicId: id } })) > 0) return
      await prisma.topicSource.create({
        data: {
          topicId: id,
          materialId,
          pageStart: plan.source.pages?.[0] ?? null,
          pageEnd: plan.source.pages?.[1] ?? null,
          chunkIndexStart: plan.source.chunks[0],
          chunkIndexEnd: plan.source.chunks[1],
          role: 'primary',
        },
      })
    })
  }
}

async function ensureContent(api: APIRequestContext, courseId: string) {
  await json(await api.post(`/api/projects/${courseId}/generate-missing-content`), 'generate missing content')
  await waitFor(async () => (await activeJobs(api, courseId, 'generate_content')).length === 0, 'content generation', 600_000, 3000)
}

async function ensureQuizAttempt(api: APIRequestContext, topicId: string) {
  const { attempts } = await json(await api.get(`/api/topics/${topicId}/quiz-attempts`), 'attempts')
  if (attempts.length > 0) return
  const { content } = await json(await api.get(`/api/topics/${topicId}/content?type=topic_quiz`), 'quiz')
  if (!content) return
  const answers: Record<string, string> = {}
  ;(content.contentData as Json[]).forEach((question, index) => {
    const kind = question.question_type
    answers[String(index)] =
      kind === 'multiple_choice'
        ? question.options[0].id
        : kind === 'true_false'
          ? 'true'
          : kind === 'numerical'
            ? '1'
            : 'A queue gives level order, so the first time BFS reaches a node is by a shortest path.'
  })
  const quizSetId = content.metadata?.quiz_set_id
  await json(
    await api.post(`/api/topics/${topicId}/quiz-attempts`, { data: { answers, ...(quizSetId ? { quizSetId } : {}) } }),
    'submit quiz'
  )
}

async function pollJob(api: APIRequestContext, jobId: string, what: string): Promise<Json> {
  return waitFor(
    async () => {
      const job = await json(await api.get(`/api/jobs/${jobId}`), what)
      if (job.status === 'failed') throw new Error(`${what} failed: ${job.errorCode} ${job.errorMessage}`)
      return job.status === 'completed' ? job : null
    },
    what,
    300_000
  )
}

async function ensureExam(api: APIRequestContext, courseId: string, topicIds: string[]) {
  const { exams } = await json(await api.get(`/api/projects/${courseId}/exams`), 'exams')
  if ((exams as Json[]).some((exam) => (exam.attemptsCount ?? 0) > 0)) return
  let examId: string
  if (exams.length > 0) {
    examId = exams[0].id
  } else {
    const job = await json(
      await api.post(`/api/projects/${courseId}/generate-exam`, {
        data: { topicIds, totalQuestions: 10, durationMinutes: 30, difficultyLevel: 'medium' },
      }),
      'create exam'
    )
    examId = (await pollJob(api, job.jobId, 'exam generation')).resultData.exam_id
  }
  await json(await api.post(`/api/exams/${examId}/attempt`), 'start exam')
  const { exam } = await json(await api.get(`/api/exams/${examId}`), 'exam')
  const answers: Record<string, string | boolean> = {}
  ;(exam.questions as Json[]).forEach((question, index) => {
    const kind = question.question_type
    answers[String(index)] =
      kind === 'multiple_choice'
        ? question.options[0].id
        : kind === 'true_false'
          ? true
          : kind === 'numerical'
            ? '1'
            : 'It depends on the structure of the graph and the order nodes are visited.'
  })
  await json(await api.put(`/api/exams/${examId}/attempt`, { data: { answers } }), 'save exam answers')
  const submitted = await json(await api.post(`/api/exams/${examId}/submit`, { data: { answers } }), 'submit exam')
  await pollJob(api, submitted.jobId, 'exam grading')
}

async function ensureChat(api: APIRequestContext, courseId: string) {
  const { threads } = await json(await api.get(`/api/projects/${courseId}/chat/threads`), 'threads')
  if (threads.length > 0) return
  const response = await api.post(`/api/projects/${courseId}/chat`, {
    data: { question: 'How does breadth-first search differ from depth-first search?' },
    timeout: 180_000,
  })
  const body = await response.text()
  if (!response.ok()) throw new Error(`chat: HTTP ${response.status()} ${body.slice(0, 300)}`)
  const failure = body
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Json)
    .find((event) => event.type === 'error')
  if (failure) throw new Error(`chat error: ${failure.code} ${failure.message}`)
}

/**
 * A topic written from a live run's output instead of the mock LLM's: key-concept chips and step
 * titles with LaTeX, currency inside and outside math, prose in math mode, long display math.
 * The mock content never stresses the renderer or the layout, this does.
 */
async function ensureMathTopic(api: APIRequestContext, courseId: string): Promise<string> {
  const algorithms = (await materials(api, courseId)).find((item) => item.filename === 'algorithms.pdf')?.id as string
  // Sources in the fixture name the sample PDF by a placeholder; the real id exists only now.
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'math-topic.json'), 'utf8').replaceAll('__ALGORITHMS_PDF__', algorithms)) as Json
  let topicId = (await topics(api, courseId)).find((topic) => topic.name === MATH_TOPIC)?.id as string | undefined
  if (!topicId) {
    const created = await json(
      await api.post(`/api/projects/${courseId}/topics`, { data: { name: MATH_TOPIC, description: fixture.description } }),
      'create the math topic'
    )
    topicId = created.topic.id as string
  }
  const contents: [string, unknown][] = [
    ['section_notes', fixture.notes],
    ['solved_examples', fixture.examples],
    ['interactive_examples', fixture.practice],
    ['topic_quiz', fixture.quiz],
  ]
  await withPrisma(async (prisma) => {
    for (const [contentType, contentData] of contents) {
      await prisma.topicContent.upsert({
        where: { topicId_contentType: { topicId: topicId as string, contentType } },
        create: { topicId: topicId as string, contentType, contentData: contentData as object },
        update: { contentData: contentData as object },
      })
    }
  })
  await json(await api.post(`/api/projects/${courseId}/topics/confirm`), 'confirm topics')
  return topicId
}

// The specs sign in with the local-only test sign-in, and the demo data is made up: local stacks only.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export async function seedDemo(baseURL: string): Promise<DemoIds> {
  const host = new URL(baseURL).hostname.replace(/^\[|\]$/g, '')
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to seed the demo account on ${host}: the e2e specs only run ` +
        'against a local stack (PLAYWRIGHT_BASE_URL=http://localhost:<port>).',
    )
  }
  const api = await request.newContext({ baseURL, timeout: 120_000 })
  try {
    await signInApi(api, DEMO_EMAIL, DEMO_NAME)
    const course = await ensureCourse(api, DEMO_COURSE, DEMO_COURSE_DESCRIPTION)
    await ensureMaterials(api, course)
    // Later runs find the math topic too; it is not one of the four mock-content topics.
    const found = (await ensureTopics(api, course)).filter((topic) => topic.name !== MATH_TOPIC)
    await ensureContent(api, course)
    await ensureQuizAttempt(api, found[0].id)
    await ensureExam(api, course, found.map((topic) => topic.id))
    await ensureChat(api, course)
    const mathTopic = await ensureMathTopic(api, course)
    // Last, so that the content above is written the way a hand-made topic's is: from a search.
    await ensureStructure(api, course)
    const setupCourse = await ensureCourse(api, SETUP_COURSE, 'Reaction mechanisms and synthesis.')
    return { course, setupCourse, topics: found.map((topic) => topic.id as string), mathTopic }
  } finally {
    await api.dispose()
  }
}
