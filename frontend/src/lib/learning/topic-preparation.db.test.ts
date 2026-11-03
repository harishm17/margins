/**
 * What a generate-content request does for concepts, against a real, migrated Postgres
 * (DATABASE_URL). Skipped when no database with the concepts table answers.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./topic-preparation')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./topic-preparation')
  available = await prisma.$queryRaw`SELECT 1 FROM concepts LIMIT 1`.then(
    () => true,
    () => false
  )
})

const dbTest = (name: string, run: () => Promise<void>) =>
  test(name, async (t) => {
    if (!available) return t.skip('no migrated test database')
    await run()
  })

async function world() {
  const user = await prisma.user.create({ data: { email: `tp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  return { user, project, topic }
}

const request = (topicId: string, extra: Partial<Parameters<typeof import('./topic-preparation').resolveRequestedContent>[0]> = {}) =>
  mod.resolveRequestedContent({ topicId, contentType: 'concepts', onlyIfMissing: true, prepareRest: true, ...extra })

dbTest('a topic with nothing starts its concepts', async () => {
  const w = await world()
  assert.deepEqual(await request(w.topic.id), { kind: 'start', contentType: 'concepts', replacing: false })
})

dbTest('a concepts job of a course-wide run is followed, not started again', async () => {
  const w = await world()
  const job = await prisma.processingJob.create({
    data: {
      userId: w.user.id,
      projectId: w.project.id,
      jobType: 'generate_content',
      status: 'processing',
      targetKey: `concepts:${w.project.id}`,
      inputData: { topicId: w.topic.id, contentType: 'concepts', preferences: { prepare_concepts: true } },
    },
  })
  assert.deepEqual(await request(w.topic.id), { kind: 'active', jobId: job.id, status: 'processing' })
  assert.deepEqual(await request(w.topic.id, { onlyIfMissing: false }), { kind: 'active', jobId: job.id, status: 'processing' })
})

dbTest('a topic whose extraction finished goes on with the first missing type', async () => {
  const w = await world()
  await prisma.processingJob.create({
    data: {
      userId: w.user.id,
      projectId: w.project.id,
      jobType: 'generate_content',
      status: 'completed',
      inputData: { topicId: w.topic.id, contentType: 'concepts', preferences: {} },
    },
  })
  assert.deepEqual(await request(w.topic.id), { kind: 'start', contentType: 'warmup', replacing: false })
  assert.deepEqual(await request(w.topic.id, { prepareRest: false }), { kind: 'exists' })
})
