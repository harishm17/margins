import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { INSTRUCTIONS, filesLeft, pageImagePath, pathsNaming, timesSaid } from './deletion'

describe('how many times a dialog gives its instruction (U4, SW15)', () => {
  const account = 'Delete your account? This permanently deletes a@b.c. Enter DELETE to confirm. Confirmation Enter DELETE to confirm Delete account Enter DELETE to confirm.'

  it('counts every layer, the text read out only with the disabled button included', () => {
    assert.equal(timesSaid(account, /\b(enter|type)\s+DELETE\b/i), 3)
  })

  it('is one when the instruction is said once', () => {
    assert.equal(timesSaid('Delete your account? Enter DELETE to confirm. Confirmation Delete account', /\b(enter|type)\s+DELETE\b/i), 1)
  })

  it('keeps the case the pattern asks for: the confirmation word is in capitals, the button is not', () => {
    assert.equal(timesSaid('Delete account. Type delete here.', /\b(enter|type)\s+DELETE\b/), 0)
  })

  it('reads the pattern as global even when it was written without the flag', () => {
    assert.equal(timesSaid('Type the name exactly to confirm Type the name exactly to confirm.', /\btype the (course )?name\b/i), 2)
  })

  // The two dialogs as they read today, every piece of text with a space between (allText): description, field, buttons,
  // and the confirm button's reason, read out only while it is off.
  it('finds the account dialog\'s three "Enter DELETE"s, whatever the capital of the verb', () => {
    assert.equal(timesSaid(account, INSTRUCTIONS.enterDelete), 3)
    assert.equal(timesSaid('Delete account. enter DELETE here.', INSTRUCTIONS.enterDelete), 1)
    assert.equal(timesSaid('Delete account. Type delete here.', INSTRUCTIONS.enterDelete), 0)
  })

  it('finds the course dialog\'s two "Type the name"s', () => {
    const course = 'Delete this course? Everything in A course goes with it. Course name A course Copy name Type the name exactly to confirm Cancel Delete course Type the name exactly to confirm.'
    assert.equal(timesSaid(course, INSTRUCTIONS.typeTheName), 2)
  })
})

describe('the files a deletion leaves', () => {
  it('is nothing when the folder is gone', () => {
    assert.deepEqual(filesLeft(path.join(tmpdir(), 'wf-deletion-never-made')), [])
  })

  it('lists every file under the folder, nested ones too, relative to it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-deletion-'))
    mkdirSync(path.join(dir, 'materials', 'm1', 'pages'), { recursive: true })
    writeFileSync(path.join(dir, 'materials', 'm1', 'notes.pdf'), 'x')
    writeFileSync(path.join(dir, 'materials', 'm1', 'pages', '0001.webp'), 'x')
    assert.deepEqual(filesLeft(dir).sort(), ['materials/m1/notes.pdf', 'materials/m1/pages/0001.webp'])
  })

  it('names the files whose path holds one of the ids', () => {
    assert.deepEqual(pathsNaming(['u1/c1/materials/m1/a.pdf', 'u1/c2/materials/m2/b.pdf'], ['m1', 'zz']), ['u1/c1/materials/m1/a.pdf'])
  })
})

describe('where a page image is stored (B8)', () => {
  it('is under the file’s own folder, in pages/, numbered to four places', () => {
    assert.equal(pageImagePath('/up', 'u1', 'c1', 'm1', 3), path.join('/up', 'u1', 'c1', 'materials', 'm1', 'pages', '0003.webp'))
  })
})
