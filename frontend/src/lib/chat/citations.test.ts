import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  insertCitationMarkers,
  markerFromHref,
  parseStoredCitations,
  quoteForDisplay,
  sourceLabel,
  viewerUrl,
  type ChatSource,
} from './citations'

const source = (overrides: Partial<ChatSource> = {}): ChatSource => ({
  marker: 1,
  chunkId: 'c1',
  materialId: 'm1',
  filename: 'notes.pdf',
  pageStart: 4,
  pageEnd: 4,
  section: null,
  citedText: 'quote',
  ...overrides,
})

describe('insertCitationMarkers', () => {
  it('puts a marker link where the cited text ended', () => {
    const text = 'Hashing maps keys. Heaps are trees.'
    const result = insertCitationMarkers(text, [{ offset: 18, marker: 1 }])
    assert.equal(result, 'Hashing maps keys.[1](#cite-1) Heaps are trees.')
  })

  it('moves back over trailing whitespace so the marker hugs the last word', () => {
    const result = insertCitationMarkers('One sentence. \n\nNext paragraph.', [{ offset: 16, marker: 2 }])
    assert.equal(result, 'One sentence.[2](#cite-2) \n\nNext paragraph.')
  })

  it('puts several markers at one place in marker order, each once', () => {
    const result = insertCitationMarkers('Done.', [
      { offset: 5, marker: 2 },
      { offset: 5, marker: 1 },
      { offset: 5, marker: 2 },
    ])
    assert.equal(result, 'Done.[1](#cite-1)[2](#cite-2)')
  })

  it('handles marks out of order and past the end of the text', () => {
    const result = insertCitationMarkers('ab cd', [
      { offset: 99, marker: 2 },
      { offset: 2, marker: 1 },
    ])
    assert.equal(result, 'ab[1](#cite-1) cd[2](#cite-2)')
  })
})

describe('quoteForDisplay', () => {
  it('drops heading marks and keeps the quoted paragraph', () => {
    assert.equal(
      quoteForDisplay('# Hash Tables\n\nCollisions happen when two keys map to one bucket.'),
      'Hash Tables\n\nCollisions happen when two keys map to one bucket.'
    )
    assert.equal(quoteForDisplay('Use # for comments #1'), 'Use # for comments #1')
  })
})

describe('markerFromHref', () => {
  it('reads citation links and nothing else', () => {
    assert.equal(markerFromHref('#cite-3'), 3)
    assert.equal(markerFromHref('#cite-0'), null)
    assert.equal(markerFromHref('#cite-x'), null)
    assert.equal(markerFromHref('https://example.com'), null)
    assert.equal(markerFromHref(undefined), null)
  })
})

describe('labels and links', () => {

  it('labels a source by page, then section, then file name', () => {
    assert.equal(sourceLabel(source()), 'notes.pdf, p. 4')
    assert.equal(
      sourceLabel(source({ filename: 'slides.pptx', pageStart: null, pageEnd: null, section: 'Week 2 > Hashing' })),
      'slides.pptx, Week 2 > Hashing'
    )
    assert.equal(sourceLabel(source({ pageStart: null, pageEnd: null })), 'notes.pdf')
  })

  it('opens a PDF at its first cited page and other files without a page', () => {
    assert.equal(viewerUrl(source({ pageStart: 7 })), '/api/materials/m1/file#page=7')
    assert.equal(viewerUrl(source({ pageStart: null })), '/api/materials/m1/file')
    assert.equal(viewerUrl(source({ filename: 'deck.pptx', pageStart: 3 })), '/api/materials/m1/file')
    assert.equal(viewerUrl(source({ materialId: 'a/b' })), '/api/materials/a%2Fb/file#page=4')
  })
})

describe('parseStoredCitations', () => {
  it('reads stored citations and drops marks whose source is missing', () => {
    const parsed = parseStoredCitations({
      sources: [
        {
          marker: 1,
          chunkId: 'c1',
          materialId: 'm1',
          filename: 'notes.pdf',
          pageStart: 2,
          pageEnd: 3,
          section: 'A > B',
          citedText: 'text',
        },
      ],
      marks: [
        { offset: 4, marker: 1 },
        { offset: 9, marker: 5 },
        { offset: -1, marker: 1 },
      ],
    })
    assert.equal(parsed.sources.length, 1)
    assert.equal(parsed.sources[0].pageEnd, 3)
    assert.deepEqual(parsed.marks, [{ offset: 4, marker: 1 }])
  })

  it('also reads the AI service snake_case shape', () => {
    const parsed = parseStoredCitations({
      sources: [{ marker: 1, chunk_id: 'c', material_id: 'm', filename: 'f.pdf', page_start: 1, page_end: 1, cited_text: 'x' }],
      marks: [],
    })
    assert.equal(parsed.sources[0].chunkId, 'c')
    assert.equal(parsed.sources[0].citedText, 'x')
  })
})
