import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { contentDisposition, contentTypeForFilename, isInlineContentType, parseByteRange } from './file-response'

describe('parseByteRange', () => {
  it('serves the whole file when there is no usable header', () => {
    for (const header of [null, undefined, '', 'items=0-5', 'bytes=', 'bytes=-', 'bytes=0-5,10-20', 'bytes=abc-def']) {
      assert.equal(parseByteRange(header, 100), null, String(header))
    }
  })

  it('reads start-end, start- and -suffix ranges', () => {
    assert.deepEqual(parseByteRange('bytes=0-9', 100), { start: 0, end: 9 })
    assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 })
    assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 })
  })

  it('refuses a range that starts past the end', () => {
    assert.equal(parseByteRange('bytes=100-', 100), 'unsatisfiable')
    assert.equal(parseByteRange('bytes=-0', 100), 'unsatisfiable')
  })
})

describe('content type', () => {
  it('maps the upload types and shows only PDFs inline', () => {
    assert.equal(contentTypeForFilename('Notes.PDF'), 'application/pdf')
    assert.match(contentTypeForFilename('a.docx'), /wordprocessingml/)
    assert.match(contentTypeForFilename('a.pptx'), /presentationml/)
    assert.equal(contentTypeForFilename('a.exe'), 'application/octet-stream')
    assert.equal(contentTypeForFilename('noextension'), 'application/octet-stream')
    assert.equal(isInlineContentType('application/pdf'), true)
    assert.equal(isInlineContentType('text/html'), false)
  })
})

describe('contentDisposition', () => {
  it('keeps header-breaking characters out and encodes the full name', () => {
    const header = contentDisposition('inline', 'Lecture "1"\r\nX: y.pdf')
    assert.doesNotMatch(header, /[\r\n]/)
    assert.match(header, /^inline; filename="Lecture _1___X: y\.pdf"/)
    assert.match(header, /filename\*=UTF-8''Lecture%20_1___X%3A%20y\.pdf$/)
  })
})
