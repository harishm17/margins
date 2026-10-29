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

test('a failing folder sweep before the row delete stops too', async () => {
  const world = fakeWorld({ failFolder: 1 })
  await assert.rejects(deleteAccount('u1', world), { name: 'AccountDeletionError', step: 'files' })
  assert.equal(world.state.exists, true)
  assert.equal((await deleteAccount('u1', world)).outcome, 'deleted')
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

test('a job-stop failure stops before any file is touched', async () => {
  const world = fakeWorld()
  world.store.stopJobs = async () => {
    throw new Error('database down')
  }
  await assert.rejects(deleteAccount('u1', world), { name: 'AccountDeletionError', step: 'jobs' })
  assert.ok(!world.calls.some((call) => call.startsWith('file:') || call.startsWith('folder:')))
  assert.equal(world.state.exists, true)
})

test('the account row that disappears between the check and the delete still ends as deleted', async () => {
  const world = fakeWorld()
  world.store.removeAccount = async () => false
  const result = await deleteAccount('u1', world)
  assert.equal(result.outcome, 'already_deleted')
})

test('confirmation needs the word DELETE', () => {
  assert.equal(confirmsDeletion('DELETE'), true)
  assert.equal(confirmsDeletion('  DELETE '), true)
  assert.equal(confirmsDeletion('delete'), false)
  assert.equal(confirmsDeletion(''), false)
  assert.equal(confirmsDeletion('DELETE ME'), false)
})
