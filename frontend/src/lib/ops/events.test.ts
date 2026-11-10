import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Storage failures that are handled and logged are also recorded for the AI service's watchdog, and an account
// deletion leaves a record a restore can replay.
const uploads = mkdtempSync(path.join(tmpdir(), 'margins-ops-'))
process.env.LOCAL_UPLOADS_DIR = uploads

async function capture() {
  const { setOpsEventWriterForTests } = await import('./events')
  const events: Array<[string, string | null]> = []
  setOpsEventWriterForTests(async (kind, detail) => {
    events.push([kind, detail])
  })
  return events
}

test('recording never throws, even when the database refuses', async () => {
  const { recordOpsEvent, setOpsEventWriterForTests } = await import('./events')
  setOpsEventWriterForTests(async () => {
    throw new Error('database down')
  })
  await recordOpsEvent('storage_delete_failed', 'x')
  setOpsEventWriterForTests(null)
})

test('a long detail is cut to 500 characters', async () => {
  const events = await capture()
  const { recordOpsEvent } = await import('./events')
  await recordOpsEvent('storage_delete_failed', 'x'.repeat(2000))
  assert.equal(events[0][1]?.length, 500)
})

test('a stored file that cannot be deleted is recorded for the watchdog', async () => {
  const events = await capture()
  process.env.S3_BUCKET = 'materials'
  const { setS3ClientForTests } = await import('../storage/s3')
  const { deleteFilesBestEffort } = await import('../storage/files')
  setS3ClientForTests({ send: async () => Promise.reject(new Error('bucket down')) } as never)
  const failed = await deleteFilesBestEffort(['s3://materials/u1/p1/materials/m1/a.pdf'])
  assert.deepEqual(failed, ['s3://materials/u1/p1/materials/m1/a.pdf'])
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'storage_delete_failed')
  assert.match(events[0][1] ?? '', /u1\/p1\/materials\/m1\/a\.pdf: Error: bucket down/)
  setS3ClientForTests(null)
  delete process.env.S3_BUCKET
})

test('a cleanup that fails after a failed record is recorded too', async () => {
  const events = await capture()
  const { recordStoredFile } = await import('../storage/files')
  await assert.rejects(
    recordStoredFile(
      'local://u1/p1/x.pdf',
      async () => {
        throw new Error('row refused')
      },
      async () => {
        throw new Error('disk gone')
      }
    ),
    /row refused/
  )
  assert.equal(events.length, 1)
  assert.match(events[0][1] ?? '', /after its record failed/)
})

test('the deletion record goes to the bucket under ops/deletions/', async () => {
  process.env.S3_BUCKET = 'materials'
  const sent: Array<{ Bucket?: string; Key?: string; Body?: unknown }> = []
  const { setS3ClientForTests } = await import('../storage/s3')
  const { writeDeletionRecord } = await import('../storage/files')
  setS3ClientForTests({
    send: async (command: { input: { Bucket?: string; Key?: string; Body?: unknown } }) => {
      sent.push(command.input)
      return {}
    },
  } as never)
  await writeDeletionRecord('4f1c2b3a-0000-4000-8000-000000000001', new Date('2026-11-09T10:00:00Z'))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].Bucket, 'materials')
  assert.equal(sent[0].Key, 'ops/deletions/4f1c2b3a-0000-4000-8000-000000000001.json')
  assert.deepEqual(JSON.parse(String(sent[0].Body)), {
    userId: '4f1c2b3a-0000-4000-8000-000000000001',
    deletedAt: '2026-11-09T10:00:00.000Z',
  })
  setS3ClientForTests(null)
  delete process.env.S3_BUCKET
})

test('without a bucket the deletion record is written to the uploads folder', async () => {
  const { writeDeletionRecord } = await import('../storage/files')
  await writeDeletionRecord('u-local-1', new Date('2026-11-09T10:00:00Z'))
  const written = JSON.parse(readFileSync(path.join(uploads, 'ops/deletions/u-local-1.json'), 'utf8'))
  assert.equal(written.userId, 'u-local-1')
})

test('an id that could name another folder is refused', async () => {
  const { writeDeletionRecord } = await import('../storage/files')
  await assert.rejects(writeDeletionRecord('../etc'), /Refusing/)
})
