/**
 * The per-account and per-course caps against a real, migrated Postgres (DATABASE_URL). Skipped when no database answers.
 * One table drives every kind: fill the scope to one below the cap (the next create is allowed), to the cap (refused,
 * with plain words), and past it (still refused, and nothing already there is touched). A last test races creates
 * through the lock.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { QuotaKind, QuotaScope } from './quota'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let quotaModule: typeof import('./quota')
let available = false
const tag = `qt${process.pid}`
const userIds: string[] = []
const CAP = 3
let draftSeq = 0

const KINDS: QuotaKind[] = ['courses', 'files', 'storage', 'units', 'topics', 'chatThreads', 'voiceSessions', 'notes', 'drafts', 'generationJobs']
const ENV: Record<QuotaKind, string> = {
  courses: 'QUOTA_COURSES',
  files: 'QUOTA_FILES_PER_COURSE',
  storage: 'QUOTA_STORAGE_MB',
  units: 'QUOTA_UNITS_PER_COURSE',
  topics: 'QUOTA_TOPICS_PER_COURSE',
  chatThreads: 'QUOTA_CHAT_THREADS_PER_COURSE',
  voiceSessions: 'QUOTA_VOICE_SESSIONS_PER_DAY',
  notes: 'QUOTA_NOTES_PER_TOPIC',
  drafts: 'QUOTA_DRAFTS',
  generationJobs: 'QUOTA_GENERATION_JOBS_PER_DAY',
}

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  quotaModule = await import('./quota')
  available = await prisma.$queryRaw`SELECT 1 FROM rate_limit_hits LIMIT 1`.then(
    () => true,
    () => false
  )
  for (const name of Object.values(ENV)) process.env[name] = String(CAP)
})

after(async () => {
  for (const name of Object.values(ENV)) delete process.env[name]
  if (available) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

async function world() {
  const user = await prisma.user.create({ data: { email: `${tag}-${userIds.length}-${Math.random().toString(36).slice(2)}@example.test` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const unit = await prisma.unit.create({ data: { projectId: project.id, title: 'U', orderIndex: 0 } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, unitId: unit.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const material = await prisma.material.create({
    data: { projectId: project.id, category: 'lecture_notes', filename: 'seed.pdf', gcsPath: `local://${tag}/seed.pdf`, sizeBytes: 1 },
  })
  return { user, project, unit, topic, material }
}
type World = Awaited<ReturnType<typeof world>>

/** Adds `n` rows of the kind inside the scope. The world already holds one unit, one topic and one file. */
const seeders: Record<QuotaKind, (w: World, n: number) => Promise<void>> = {
  courses: async (w, n) => {
    for (let i = 0; i < n; i++) await prisma.project.create({ data: { userId: w.user.id, name: `C${i}` } })
  },
  files: async (w, n) => {
    for (let i = 0; i < n; i++) {
      await prisma.material.create({
        data: { projectId: w.project.id, category: 'lecture_notes', filename: `f${i}.pdf`, gcsPath: `local://${tag}/f${i}-${Math.random()}.pdf`, sizeBytes: 1 },
      })
    }
  },
  storage: async (w, n) => {
    // Each file is 1 MB less one byte, so `n` of them stay clear of the cap by the same margin.
    for (let i = 0; i < n; i++) {
      await prisma.material.create({
        data: { projectId: w.project.id, category: 'lecture_notes', filename: `s${i}.pdf`, gcsPath: `local://${tag}/s${i}-${Math.random()}.pdf`, sizeBytes: 1024 * 1024 - 1 },
      })
    }
  },
  units: async (w, n) => {
    for (let i = 0; i < n; i++) await prisma.unit.create({ data: { projectId: w.project.id, title: `U${i}`, orderIndex: i + 1 } })
  },
  topics: async (w, n) => {
    for (let i = 0; i < n; i++) await prisma.topic.create({ data: { projectId: w.project.id, unitId: w.unit.id, name: `T${i}`, orderIndex: i + 1 } })
  },
  chatThreads: async (w, n) => {
    for (let i = 0; i < n; i++) await prisma.chatThread.create({ data: { userId: w.user.id, projectId: w.project.id, title: `t${i}` } })
  },
  voiceSessions: async (w, n) => {
    for (let i = 0; i < n; i++) await prisma.voiceDrillSession.create({ data: { userId: w.user.id, projectId: w.project.id, style: 'teach_back', questionSet: [] } })
  },
  notes: async (w, n) => {
    for (let i = 0; i < n; i++) {
      await prisma.marginNote.create({ data: { userId: w.user.id, projectId: w.topic.projectId, topicId: w.topic.id, materialId: w.material.id, chunkId: `c${i}`, kind: 'note', text: 'n' } })
    }
  },
  drafts: async (w, n) => {
    for (let i = 0; i < n; i++) {
      await prisma.studyDraft.create({
        data: {
          userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, surface: 'recall', scopeKey: `${w.topic.id}:card-${draftSeq++}`,
          payload: { text: 'x' }, expiresAt: new Date(Date.now() + 14 * 24 * 3600_000),
        },
      })
    }
  },
  generationJobs: async (w, n) => {
    for (let i = 0; i < n; i++) {
      await prisma.processingJob.create({
        data: { userId: w.user.id, projectId: w.project.id, jobType: 'generate_content', status: 'completed', quotaCounted: true, targetKey: `${tag}:${i}:${Math.random()}`, inputData: {} },
      })
    }
  },
}

/** Rows the world already holds for the kind, so the table can fill to a chosen count. */
const alreadyThere: Partial<Record<QuotaKind, number>> = { courses: 1, files: 1, units: 1, topics: 1 }

const scopeFor = (kind: QuotaKind, w: World): QuotaScope => {
  if (kind === 'storage') return { bytes: 1 }
  return { projectId: w.project.id, topicId: w.topic.id, now: new Date() }
}

const count = async (kind: QuotaKind, w: World): Promise<number> => {
  switch (kind) {
    case 'courses': return prisma.project.count({ where: { userId: w.user.id } })
    case 'files': return prisma.material.count({ where: { projectId: w.project.id } })
    case 'storage': return prisma.material.count({ where: { project: { userId: w.user.id } } })
    case 'units': return prisma.unit.count({ where: { projectId: w.project.id } })
    case 'topics': return prisma.topic.count({ where: { projectId: w.project.id } })
    case 'chatThreads': return prisma.chatThread.count({ where: { userId: w.user.id } })
    case 'voiceSessions': return prisma.voiceDrillSession.count({ where: { userId: w.user.id } })
    case 'notes': return prisma.marginNote.count({ where: { userId: w.user.id } })
    case 'drafts': return prisma.studyDraft.count({ where: { userId: w.user.id } })
    case 'generationJobs': return prisma.processingJob.count({ where: { userId: w.user.id } })
  }
}

for (const kind of KINDS) {
  test(`${kind}: one below the cap is allowed, at the cap is refused in plain words, and nothing already there is removed`, { skip: !process.env.DATABASE_URL }, async (t) => {
    if (!available) return t.skip('no migrated test database')
    const { quota, quotaLimit } = quotaModule
    assert.equal(quotaLimit(kind), CAP)
    const w = await world()
    const seed = seeders[kind]
    const have = alreadyThere[kind] ?? 0
    const ask = (scope: QuotaScope = scopeFor(kind, w)) => prisma.$transaction((tx) => quota(tx, w.user, kind, scope))

    if (kind === 'storage') {
      // The cap is on the total after the new file: 2 MB less 2 bytes held, so one more byte fits, 2 MB more does not.
      await seed(w, CAP - 1)
      assert.equal(await ask({ bytes: 1 }), null)
      const refused = await ask({ bytes: 2 * 1024 * 1024 })
      assert.ok(refused)
      assert.equal(refused.kind, 'storage')
      assert.match(refused.message, /^Your files can take up to 3 MB/)
    } else {
      await seed(w, CAP - 1 - have)
      assert.equal(await ask(), null, 'room for one more')
      await seed(w, 1)
      const refused = await ask()
      assert.ok(refused, 'at the cap')
      assert.equal(refused.kind, kind)
      assert.equal(refused.limit, CAP)
      assert.doesNotMatch(refused.message, /!|quota|exceeded/i)
      // Already past the cap (a student from before the caps): still refused, and everything stays.
      await seed(w, 2)
      const before = await count(kind, w)
      assert.ok(await ask())
      assert.equal(await count(kind, w), before)
    }
  })
}

// Review of PR 88: preparing a course of about 34 topics chained 200+ generate_content rows under the student's id, and
// every later request was refused for a day. Jobs the AI service chains are not the student's requests.
test('jobs the AI service chains after a request do not count toward the daily request cap', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world()
  for (let i = 0; i < CAP * 3; i++) {
    await prisma.processingJob.create({
      data: { userId: w.user.id, projectId: w.project.id, jobType: 'generate_content', status: 'completed', targetKey: `${tag}:chain:${i}:${Math.random()}`, inputData: {} },
    })
  }
  assert.equal(await prisma.$transaction((tx) => quotaModule.quota(tx, w.user, 'generationJobs', scopeFor('generationJobs', w))), null)
})

test('the refusal is a 409 with the code the screens read and the plain text as its message', { skip: !process.env.DATABASE_URL }, async () => {
  const response = quotaModule.quotaResponse({ kind: 'courses', limit: 20, message: 'You can have up to 20 courses. Delete one to add another.' })
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.error.message, 'You can have up to 20 courses. Delete one to add another.')
  assert.equal(body.error.details.code, 'QUOTA_EXCEEDED')
  assert.equal(body.error.details.retryable, false)
})

test('requests racing for the last places cannot both pass', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world()
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      prisma.$transaction(async (tx) => {
        await quotaModule.assertQuota(tx, w.user, 'courses')
        await tx.project.create({ data: { userId: w.user.id, name: `race${i}` } })
      })
    )
  )
  const made = attempts.filter((a) => a.status === 'fulfilled').length
  assert.equal(made, CAP - 1) // the world's own course is one of the three
  assert.equal(await prisma.project.count({ where: { userId: w.user.id } }), CAP)
  for (const a of attempts) {
    if (a.status === 'rejected') assert.ok(a.reason instanceof quotaModule.QuotaExceededError)
  }
})
