import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Deleting a stored file that is already gone counts as deleted, in every backend, so account
// deletion (and any other cleanup) can be retried after a partial failure. Local disk and S3 here;
// Cloud Storage in storage-delete-gcs.test.ts (it needs its own environment).
const uploads = mkdtempSync(path.join(tmpdir(), 'margins-delete-'))
process.env.LOCAL_UPLOADS_DIR = uploads
process.env.ENABLE_GCS_STORAGE = 'false'
process.env.S3_BUCKET = 'materials'

const notFound = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })

test('local: a missing file is deleted; a present one is removed', async () => {
  const { deleteFile } = await import('./gcs')
  await deleteFile('gs://margins-materials/u1/p1/materials/m1/gone.pdf')
  const present = path.join(uploads, 'u1/p1/materials/m2/here.pdf')
  mkdirSync(path.dirname(present), { recursive: true })
  writeFileSync(present, 'x')
  await deleteFile('gs://margins-materials/u1/p1/materials/m2/here.pdf')
  assert.equal(existsSync(present), false)
})

test('S3: a store that answers 404 for a missing key counts as deleted', async () => {
  const { setS3ClientForTests } = await import('./s3')
  const { deleteFile } = await import('./gcs')
  setS3ClientForTests({ send: async () => Promise.reject(notFound) } as never)
  await deleteFile('s3://materials/u1/p1/materials/m1/gone.pdf')
})

test('S3: any other error still fails, so the caller can retry', async () => {
  const { setS3ClientForTests } = await import('./s3')
  const { deleteFile } = await import('./gcs')
  setS3ClientForTests({ send: async () => Promise.reject(Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } })) } as never)
  await assert.rejects(deleteFile('s3://materials/u1/p1/materials/m1/a.pdf'), /denied/)
})

test('recordStoredFile: a failed record deletes the stored file and keeps its own error', async () => {
  const { recordStoredFile } = await import('./gcs')
  const removed: string[] = []
  const remove = async (path: string) => {
    removed.push(path)
  }
  await assert.rejects(
    recordStoredFile('s3://materials/u1/p1/m1/a.pdf', async () => Promise.reject(new Error('project is gone')), remove),
    /project is gone/
  )
  assert.deepEqual(removed, ['s3://materials/u1/p1/m1/a.pdf'])

  // A cleanup that fails too: the record's error is the one that comes out.
  await assert.rejects(
    recordStoredFile('s3://materials/u1/p1/m1/b.pdf', async () => Promise.reject(new Error('refused')), async () => {
      throw new Error('bucket down')
    }),
    /refused/
  )

  // A record that works keeps the file.
  removed.length = 0
  assert.equal(await recordStoredFile('s3://materials/u1/p1/m1/c.pdf', async () => 'ok', remove), 'ok')
  assert.deepEqual(removed, [])
})

test('S3 folder sweep: an object that disappears between the list and the delete does not fail it', async () => {
  const { setS3ClientForTests, deleteS3Prefix } = await import('./s3')
  const deleted: string[] = []
  setS3ClientForTests({
    send: async (command: { constructor: { name: string }; input: { Key?: string } }) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'u1/a.pdf' }, { Key: 'u1/gone.pdf' }, { Key: 'u1/b.pdf' }], IsTruncated: false }
      }
      if (command.input.Key === 'u1/gone.pdf') throw notFound
      deleted.push(command.input.Key as string)
      return {}
    },
  } as never)
  await deleteS3Prefix('u1/')
  assert.deepEqual(deleted, ['u1/a.pdf', 'u1/b.pdf'])

  // Any other error still fails the sweep.
  setS3ClientForTests({
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'u1/a.pdf' }] }
      throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } })
    },
  } as never)
  await assert.rejects(deleteS3Prefix('u1/'), /denied/)
})
