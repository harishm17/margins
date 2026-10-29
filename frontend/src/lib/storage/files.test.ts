import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// The module reads LOCAL_UPLOADS_DIR when it loads, so it is imported inside each test.
const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-files-test-'))
process.env.LOCAL_UPLOADS_DIR = uploads
delete process.env.S3_BUCKET

const load = () => import('./files')

async function readAll(stream: Readable): Promise<string> {
  const parts: Buffer[] = []
  for await (const part of stream) parts.push(Buffer.from(part))
  return Buffer.concat(parts).toString('utf8')
}

test('parseLocalPath reads local:// paths and the older gs://bucket/ form', async () => {
  const { parseLocalPath } = await load()
  assert.equal(parseLocalPath('local://u1/p1/materials/m1/notes.pdf'), 'u1/p1/materials/m1/notes.pdf')
  assert.equal(parseLocalPath('gs://local-materials/u1/p1/notes.pdf'), 'u1/p1/notes.pdf')
  assert.equal(parseLocalPath('gs://margins-materials/u1/p1/notes.pdf'), 'u1/p1/notes.pdf')
})

test('parseLocalPath ignores bucket paths and malformed ones', async () => {
  const { parseLocalPath } = await load()
  assert.equal(parseLocalPath('s3://bucket/u1/p1/notes.pdf'), null)
  assert.equal(parseLocalPath('local://'), null)
  assert.equal(parseLocalPath('gs://only-a-bucket'), null)
  assert.equal(parseLocalPath('showcase/c1/notes.pdf'), null)
})

test('a local upload is stored as local://, read back and deleted', async () => {
  const { uploadStream, openStoredFile, deleteFile } = await load()
  const stored = await uploadStream(Readable.from(['hello']), 'u1/p1/materials/m1/a.pdf')
  assert.equal(stored, 'local://u1/p1/materials/m1/a.pdf')

  const file = await openStoredFile(stored)
  assert.ok(file)
  assert.equal(file.size, 5)
  assert.equal(await readAll(file.stream()), 'hello')

  await deleteFile(stored)
  assert.equal(fs.existsSync(path.join(uploads, 'u1/p1/materials/m1/a.pdf')), false)
  assert.equal(await openStoredFile(stored), null)
})

test('an older gs:// local upload is still read and deleted', async () => {
  const { openStoredFile, deleteFile } = await load()
  const target = path.join(uploads, 'u2/p2/materials/m2/old.pdf')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'old')

  const file = await openStoredFile('gs://local-materials/u2/p2/materials/m2/old.pdf')
  assert.ok(file)
  assert.equal(await readAll(file.stream()), 'old')

  await deleteFile('gs://any-bucket-name/u2/p2/materials/m2/old.pdf')
  assert.equal(fs.existsSync(target), false)
})

test('stored paths never reach outside the upload folder', async () => {
  const { openStoredFile, deleteFile } = await load()
  const outside = path.join(path.dirname(uploads), `margins-outside-${process.pid}.pdf`)
  fs.writeFileSync(outside, 'secret')
  try {
    const relative = `../${path.basename(outside)}`
    assert.equal(await openStoredFile(`local://${relative}`), null)
    await deleteFile(`local://${relative}`)
    await deleteFile(`gs://bucket/${relative}`)
    assert.equal(fs.existsSync(outside), true)
  } finally {
    fs.rmSync(outside, { force: true })
  }
})

test('deleteProjectFolder removes only that project', async () => {
  const { uploadStream, deleteProjectFolder } = await load()
  await uploadStream(Readable.from(['a']), 'u3/p3/materials/m3/a.pdf')
  await uploadStream(Readable.from(['b']), 'u3/p4/materials/m4/b.pdf')

  assert.equal(await deleteProjectFolder('u3', 'p3'), true)
  assert.equal(fs.existsSync(path.join(uploads, 'u3/p3')), false)
  assert.equal(fs.existsSync(path.join(uploads, 'u3/p4/materials/m4/b.pdf')), true)
})
