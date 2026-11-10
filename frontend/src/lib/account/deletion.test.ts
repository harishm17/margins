import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountDeletionError, confirmsDeletion, deleteAccount, type DeletionFiles, type DeletionStore } from './deletion'

/** An in-memory account with jobs and files, recording every call in order. */
function fakeWorld(options: { files?: string[]; failPaths?: string[]; failFolder?: number; failRemove?: number } = {}) {
  const calls: string[] = []
  const state = {
    exists: true,
    activeJobs: 2,
    // What is in storage: the materials' own paths, plus a stray file under the user's folder.
    stored: new Set([...(options.files ?? ['s3://b/u1/p1/materials/m1/a.pdf', 'gs://b/u1/p1/materials/m2/b.pdf']), 'u1/stray']),
    ledgerLinked: true,
  }
  const failPaths = new Set(options.failPaths ?? [])
  let folderFailures = options.failFolder ?? 0
  let removeFailures = options.failRemove ?? 0
  const materialPaths = options.files ?? ['s3://b/u1/p1/materials/m1/a.pdf', 'gs://b/u1/p1/materials/m2/b.pdf']

  const store: DeletionStore = {
    async accountExists(userId) {
      calls.push(`exists:${userId}`)
      return state.exists
    },
    async stopJobs() {
      calls.push('stopJobs')
      const stopped = state.activeJobs
      state.activeJobs = 0
      return stopped
    },
    async storedFilePaths() {
      calls.push('paths')
      return state.exists ? materialPaths : []
    },
    async removeAccount() {
      calls.push('remove')
      if (removeFailures > 0) {
        removeFailures -= 1
        throw new Error('database down')
      }
      const was = state.exists
      state.exists = false
      state.ledgerLinked = false
      return was
    },
  }
  const files: DeletionFiles = {
    async deleteFile(path) {
      calls.push(`file:${path}`)
      if (failPaths.has(path)) {
        failPaths.delete(path)
        throw new Error('storage down')
      }
      // Missing files are fine: deleting resolves either way.
      state.stored.delete(path)
    },
    async deleteUserFiles(userId) {
      calls.push(`folder:${userId}`)
      if (folderFailures > 0) {
        folderFailures -= 1
        throw new Error('bucket down')
      }
      state.stored.delete('u1/stray')
    },
  }
  const logged: string[] = []
  const log = { info: (m: string) => logged.push(`info ${m}`), error: (m: string) => logged.push(`error ${m}`) }
  return { calls, state, store, files, log, logged }
}

test('stops jobs, then deletes files, then the account, then sweeps the folder again', async () => {
  const world = fakeWorld()
  const result = await deleteAccount('u1', world)
  assert.deepEqual(world.calls, [
    'exists:u1',
    'stopJobs',
    'paths',
    'file:s3://b/u1/p1/materials/m1/a.pdf',
    'file:gs://b/u1/p1/materials/m2/b.pdf',
    'folder:u1',
    'remove',
    'folder:u1',
  ])
  assert.deepEqual(result, { outcome: 'deleted', stoppedJobs: 2, deletedFiles: 2 })
  assert.equal(world.state.exists, false)
  assert.equal(world.state.stored.size, 0)
  assert.equal(world.state.activeJobs, 0)
  assert.ok(world.logged.some((line) => line.startsWith('info [ACCOUNT] Deleted account u1')))
})

test('a storage failure keeps the account, tries every other file, and a retry finishes', async () => {
  const world = fakeWorld({ failPaths: ['s3://b/u1/p1/materials/m1/a.pdf'] })
  await assert.rejects(deleteAccount('u1', world), (error: unknown) => {
    assert.ok(error instanceof AccountDeletionError)
    assert.equal(error.step, 'files')
    return true
  })
  // The other file and the folder were still attempted; the account row was not touched.
  assert.ok(world.calls.includes('file:gs://b/u1/p1/materials/m2/b.pdf'))
  assert.ok(world.calls.includes('folder:u1'))
  assert.ok(!world.calls.includes('remove'))
  assert.equal(world.state.exists, true)

  world.calls.length = 0
  const result = await deleteAccount('u1', world)
  assert.equal(result.outcome, 'deleted')
  assert.equal(world.state.exists, false)
  assert.equal(world.state.stored.size, 0)
})

test('a database failure on the row delete is retryable: files already gone count as deleted', async () => {
  const world = fakeWorld({ failRemove: 1 })
  await assert.rejects(deleteAccount('u1', world), { name: 'AccountDeletionError', step: 'account' })
  assert.equal(world.state.exists, true)
  assert.equal(world.state.stored.size, 0)

  world.calls.length = 0
  const result = await deleteAccount('u1', world)
  assert.equal(result.outcome, 'deleted')
  // The files are deleted again (a no-op), then the row.
  assert.deepEqual(world.calls.slice(-4), ['file:gs://b/u1/p1/materials/m2/b.pdf', 'folder:u1', 'remove', 'folder:u1'])
})

test('an account that is already gone succeeds and only sweeps its folder', async () => {
  const world = fakeWorld()
  world.state.exists = false
  const result = await deleteAccount('u1', world)
  assert.deepEqual(result, { outcome: 'already_deleted', stoppedJobs: 0, deletedFiles: 0 })
  assert.deepEqual(world.calls, ['exists:u1', 'folder:u1'])
})

test('a job-stop failure stops before any file is touched', async () => {
  const world = fakeWorld()
  world.store.stopJobs = async () => {
    throw new Error('database down')
  }
  await assert.rejects(deleteAccount('u1', world), { name: 'AccountDeletionError', step: 'jobs' })
  assert.ok(!world.calls.some((call) => call.startsWith('file:') || call.startsWith('folder:')))
  assert.equal(world.state.exists, true)
})

function recording(world: ReturnType<typeof fakeWorld>, fail = false) {
  const notes: string[] = []
  const files: DeletionFiles = {
    ...world.files,
    async recordDeletion(userId) {
      world.calls.push(`record:${userId}`)
      if (fail) throw new Error('bucket down')
    },
  }
  const note = async (kind: string, detail: string) => {
    notes.push(`${kind} ${detail}`)
  }
  return { files, note, notes }
}

test('the deletion is recorded for restores only after the row is gone', async () => {
  const world = fakeWorld()
  const { files, note, notes } = recording(world)
  await deleteAccount('u1', { ...world, files, note })
  assert.ok(world.calls.indexOf('record:u1') > world.calls.indexOf('remove'))
  assert.deepEqual(notes, [])
})

test('a failure before the row delete records nothing and tells the operator', async () => {
  const world = fakeWorld({ failRemove: 1 })
  const { files, note, notes } = recording(world)
  await assert.rejects(deleteAccount('u1', { ...world, files, note }), { step: 'account' })
  assert.ok(!world.calls.includes('record:u1'))
  assert.deepEqual(notes, ['account_delete_failed u1: stopped at account'])
})

test('a deletion record that cannot be written leaves the deletion done and tells the operator', async () => {
  const world = fakeWorld()
  const { files, note, notes } = recording(world, true)
  const result = await deleteAccount('u1', { ...world, files, note })
  assert.equal(result.outcome, 'deleted')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^deletion_record_failed u1: /)
})

test('a retry for an account already gone records the deletion again', async () => {
  const world = fakeWorld()
  world.state.exists = false
  const { files, note } = recording(world)
  await deleteAccount('u1', { ...world, files, note })
  assert.deepEqual(world.calls, ['exists:u1', 'folder:u1', 'record:u1'])
})

test('a sweep that fails after the row is gone is noted for the operator', async () => {
  const world = fakeWorld()
  const { note, notes } = recording(world)
  let folderCalls = 0
  const files: DeletionFiles = {
    deleteFile: world.files.deleteFile,
    async deleteUserFiles(userId) {
      folderCalls += 1
      if (folderCalls === 2) throw new Error('bucket down')
      return world.files.deleteUserFiles(userId)
    },
  }
  await deleteAccount('u1', { ...world, files, note })
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^storage_delete_failed folder u1\/ after account deletion/)
})

test('confirmation needs the word DELETE', () => {
  assert.equal(confirmsDeletion('DELETE'), true)
  assert.equal(confirmsDeletion('  DELETE '), true)
  assert.equal(confirmsDeletion('delete'), true)
  assert.equal(confirmsDeletion(' Delete '), true)
  assert.equal(confirmsDeletion('delet'), false)
  assert.equal(confirmsDeletion(''), false)
  assert.equal(confirmsDeletion('DELETE ME'), false)
})

// The learner model's tables, against a real Postgres (DATABASE_URL): deleting the account takes
// every row of them with it. Skipped when no database answers.
test('deleting a user removes concept memory, evidence, recall attempts, margin notes, tutor state, item sessions and study drafts', async (t) => {
  const { prisma } = await import('@/lib/db/prisma')
  const reachable = await prisma.$queryRaw`SELECT 1 FROM users LIMIT 1`.then(
    () => true,
    () => false
  )
  if (!reachable) return t.skip('no migrated test database')

  const user = await prisma.user.create({ data: { email: `del-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0 } })
  const material = await prisma.material.create({
    data: { projectId: project.id, category: 'lecture_notes', filename: 'a.pdf', gcsPath: 'local://u/p/a.pdf', sizeBytes: 1 },
  })
  const concept = (orderIndex: number) =>
    prisma.concept.create({
      data: { projectId: project.id, topicId: topic.id, name: `C${orderIndex}`, summary: 'An idea.', kind: 'concept', orderIndex },
    })
  const [a, b] = [await concept(0), await concept(1)]
  await prisma.conceptClaim.create({
    data: { conceptId: a.id, text: 'Claim', quote: 'Quote', materialId: material.id, orderIndex: 0 },
  })
  await prisma.conceptEdge.create({
    data: { projectId: project.id, sourceId: a.id, targetId: b.id, type: 'prerequisite', weight: 1, confidence: 0.8 },
  })
  await prisma.evidenceEvent.create({
    data: {
      userId: user.id, projectId: project.id, topicId: topic.id, conceptId: a.id, itemKey: 'quiz:q1', source: 'quiz',
      score: 1, assistance: 0, weight: 1, role: 'primary', gradedBy: 'rule', sessionKey: 's1',
    },
  })
  await prisma.conceptMemory.create({ data: { userId: user.id, projectId: project.id, topicId: topic.id, conceptId: a.id } })
  await prisma.recallAttempt.create({
    data: { userId: user.id, topicId: topic.id, kind: 'recall', promptText: 'Say it.', answerText: 'It is.', mode: 'text', result: {} },
  })
  await prisma.marginNote.create({
    data: { userId: user.id, topicId: topic.id, materialId: material.id, chunkId: 'chunk-1', kind: 'note', text: 'Note' },
  })
  await prisma.tutorState.create({ data: { userId: user.id, scope: 'practice', scopeKey: 'step-1' } })
  await prisma.itemSession.create({ data: { userId: user.id, projectId: project.id, kind: 'warmup', items: [] } })
  await prisma.studyDraft.create({
    data: {
      userId: user.id, projectId: project.id, topicId: topic.id, surface: 'recall', scopeKey: `${topic.id}:card-1`,
      payload: { text: 'half an answer' }, expiresAt: new Date(Date.now() + 14 * 24 * 3600_000),
    },
  })

  await prisma.$queryRaw`SELECT delete_user_account(${user.id})`
  // Other rows may share the tables, so count what this user owned.
  const owned = await Promise.all([
    prisma.concept.count({ where: { projectId: project.id } }),
    prisma.conceptClaim.count({ where: { conceptId: { in: [a.id, b.id] } } }),
    prisma.conceptEdge.count({ where: { projectId: project.id } }),
    prisma.evidenceEvent.count({ where: { userId: user.id } }),
    prisma.conceptMemory.count({ where: { userId: user.id } }),
    prisma.recallAttempt.count({ where: { userId: user.id } }),
    prisma.marginNote.count({ where: { userId: user.id } }),
    prisma.tutorState.count({ where: { userId: user.id } }),
    prisma.itemSession.count({ where: { userId: user.id } }),
    prisma.studyDraft.count({ where: { userId: user.id } }),
  ])
  assert.deepEqual(owned, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
})

test('a failed sweep after the row is gone is logged, not thrown', async () => {
  // First folder call (before the row delete) works; the sweep after it fails.
  const world = fakeWorld()
  let folderCalls = 0
  const files: DeletionFiles = {
    deleteFile: world.files.deleteFile,
    async deleteUserFiles(userId) {
      folderCalls += 1
      if (folderCalls === 2) throw new Error('bucket down')
      return world.files.deleteUserFiles(userId)
    },
  }
  const result = await deleteAccount('u1', { ...world, files })
  assert.equal(result.outcome, 'deleted')
  assert.ok(world.logged.some((line) => line.startsWith('error') && line.includes('remove u1/ by hand')))
})
