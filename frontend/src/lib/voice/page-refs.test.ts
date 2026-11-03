import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { linkForLabel, pageLabel, parsePageRefs } from './page-refs'

describe('pageLabel', () => {
  it('is one page or a range', () => {
    assert.equal(pageLabel(5), 'p. 5')
    assert.equal(pageLabel(5, null), 'p. 5')
    assert.equal(pageLabel(5, 5), 'p. 5')
    assert.equal(pageLabel(5, 7), 'pp. 5-7')
  })
})

describe('parsePageRefs', () => {
  it('reads single pages in every spelling', () => {
    for (const text of ['p. 5', 'p.5', 'p 5', 'P. 5', 'page 5', 'Page 5', 'see p. 5 for more']) {
      assert.deepEqual(parsePageRefs(text), [{ start: 5, end: 5 }], text)
    }
  })
  it('reads ranges with a hyphen, an en dash, an em dash or "to"', () => {
    for (const text of ['pp. 4-6', 'pp. 4–6', 'pp. 4—6', 'pages 4 to 6', 'p. 4 - 6', 'pp.4-6']) {
      assert.deepEqual(parsePageRefs(text), [{ start: 4, end: 6 }], text)
    }
  })
  it('reads lists of pages and ranges', () => {
    assert.deepEqual(parsePageRefs('pages 4 and 6'), [{ start: 4, end: 4 }, { start: 6, end: 6 }])
    assert.deepEqual(parsePageRefs('pp. 4, 6-7'), [{ start: 4, end: 4 }, { start: 6, end: 7 }])
    assert.deepEqual(parsePageRefs('p. 3; p. 9'), [{ start: 3, end: 3 }, { start: 9, end: 9 }])
  })
  it('keeps a backwards range as its first page and ignores text with no page', () => {
    assert.deepEqual(parsePageRefs('pp. 9-4'), [{ start: 9, end: 9 }])
    assert.deepEqual(parsePageRefs('the second paragraph'), [])
    assert.deepEqual(parsePageRefs('page break'), [])
    assert.deepEqual(parsePageRefs('slides.pdf'), [])
  })
})

describe('linkForLabel', () => {
  const links = [
    { label: 'p. 5', href: '/a#page=5' },
    { label: 'pp. 8-10', href: '/b#page=8' },
  ]
  it('finds the link with the same label', () => {
    assert.equal(linkForLabel('p. 5', links)?.href, '/a#page=5')
  })
  it('finds a range that covers the page, whatever the spelling', () => {
    assert.equal(linkForLabel('page 9', links)?.href, '/b#page=8')
    assert.equal(linkForLabel('pp. 9–11', links)?.href, '/b#page=8')
    assert.equal(linkForLabel('Page 5', links)?.href, '/a#page=5')
  })
  it('finds nothing for a page no link covers or text with no page', () => {
    assert.equal(linkForLabel('p. 20', links), undefined)
    assert.equal(linkForLabel('the intro', links), undefined)
  })
})
