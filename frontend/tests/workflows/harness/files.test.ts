import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { citing, deadCitations, renamedCopyName, type SourceRow } from './files'

const row = (label: string, text = label, opens = true): SourceRow => ({ label, text, opens })

describe('the sources that cite a file', () => {
  it('match the file name alone or before its place', () => {
    const rows = [row('notes-a.pdf, p. 3'), row('notes-a.pdf'), row('notes-b.pdf, p. 1')]
    assert.deepEqual(
      citing(rows, 'notes-a.pdf').map((source) => source.label),
      ['notes-a.pdf, p. 3', 'notes-a.pdf']
    )
  })

  it('do not match a file whose name only starts the same', () => {
    assert.deepEqual(citing([row('notes-a.pdf.bak, p. 2'), row('notes-a.pdfx')], 'notes-a.pdf'), [])
  })
})

describe('citations of a removed file (F5)', () => {
  it('are dead while they still open the file', () => {
    assert.deepEqual(deadCitations([row('notes-a.pdf, p. 3', 'notes-a.pdf, p. 3 Source removed Open page')], 'notes-a.pdf'), [
      'notes-a.pdf, p. 3: still opens the file',
    ])
  })

  it('are dead while they do not say the source was removed', () => {
    assert.deepEqual(deadCitations([row('notes-a.pdf, p. 3', 'notes-a.pdf, p. 3', false)], 'notes-a.pdf'), [
      'notes-a.pdf, p. 3: does not say "source removed"',
    ])
  })

  it('are fine once marked and no longer opening', () => {
    assert.deepEqual(deadCitations([row('notes-a.pdf, p. 3', 'notes-a.pdf, p. 3 Source removed', false)], 'notes-a.pdf'), [])
  })

  it("leave the other files' citations alone", () => {
    assert.deepEqual(deadCitations([row('notes-b.pdf, p. 1')], 'notes-a.pdf'), [])
  })
})

describe('a renamed copy', () => {
  it('takes the name a browser gives a second download', () => {
    assert.equal(renamedCopyName('lecture-2.pdf'), 'lecture-2 (1).pdf')
  })

  it('keeps a name with no extension readable', () => {
    assert.equal(renamedCopyName('notes'), 'notes (1)')
  })
})
