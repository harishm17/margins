import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkInlineHtml } from './inline-html'

const html = (source: string) =>
  renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkInlineHtml] }, source))

describe('remarkInlineHtml', () => {
  it('turns the reader\'s superscripts, subscripts and underlines into elements', () => {
    assert.equal(html('Time is n<sup>2</sup> and H<sub>2</sub>O and <u>this</u>.'), '<p>Time is n<sup>2</sup> and H<sub>2</sub>O and <u>this</u>.</p>')
  })

  it('turns a break inside a table cell into a line break', () => {
    const out = html('| Input<br>size | Time |\n|---|---|\n| n | n<sup>2</sup><br/>steps |')
    assert.match(out, /<th>Input<br\/>\s*size<\/th>/)
    assert.match(out, /<td>n<sup>2<\/sup><br\/>\s*steps<\/td>/)
    assert.doesNotMatch(out, /&lt;/)
  })

  it('still shows any other tag as text, so a page cannot bring its own markup', () => {
    const out = html('A <script>alert(1)</script> and <img src=x onerror=alert(1)> and <b>bold</b>')
    assert.doesNotMatch(out, /<script|<img|<b>/)
    assert.match(out, /&lt;/)
  })
})
