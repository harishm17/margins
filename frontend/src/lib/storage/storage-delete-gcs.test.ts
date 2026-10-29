import { test } from 'node:test'
import assert from 'node:assert/strict'

// Cloud Storage with the local fallback off (the reviewer's setup): deleting an object that is
// already gone must count as deleted, not throw a 404. Removed with the GCS backend (PR #41).
process.env.ENABLE_GCS_STORAGE = 'true'
process.env.GCS_PROJECT_ID = 'test-project'
process.env.ALLOW_GCS_LOCAL_FALLBACK = 'false'
delete process.env.S3_BUCKET

/** A bucket where nothing exists: delete() 404s unless told to ignore that. */
function emptyBucket(calls: string[]) {
  return {
    bucket: () => ({
      file: (name: string) => ({
        async delete(options?: { ignoreNotFound?: boolean }) {
          calls.push(name)
          if (options?.ignoreNotFound) return
          throw Object.assign(new Error('No such object'), { code: 404 })
        },
      }),
    }),
  }
}

test('GCS: a missing object counts as deleted', async () => {
  const { deleteFile, setGcsStorageForTests } = await import('./gcs')
  const calls: string[] = []
  setGcsStorageForTests(emptyBucket(calls))
  await deleteFile('gs://margins-materials/u1/p1/materials/m1/gone.pdf')
  assert.deepEqual(calls, ['u1/p1/materials/m1/gone.pdf'])
})

test('GCS: any other error still fails', async () => {
  const { deleteFile, setGcsStorageForTests } = await import('./gcs')
  setGcsStorageForTests({
    bucket: () => ({ file: () => ({ delete: async () => Promise.reject(Object.assign(new Error('forbidden'), { code: 403 })) }) }),
  })
  await assert.rejects(deleteFile('gs://margins-materials/u1/a.pdf'), /forbidden/)
})

test('GCS folder sweep: asks the bucket to ignore objects that vanished mid-delete', async () => {
  const { deleteUserFiles, setGcsStorageForTests } = await import('./gcs')
  let options: Record<string, unknown> | undefined
  setGcsStorageForTests({
    bucket: () => ({
      deleteFiles: async (opts: Record<string, unknown>) => {
        options = opts
      },
    }),
  })
  await deleteUserFiles('u1')
  assert.deepEqual(options, { prefix: 'u1/', force: true, ignoreNotFound: true })
})
