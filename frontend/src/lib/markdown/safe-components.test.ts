import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { safeComponents } from './safe-components'

const html = (source: string) =>
  renderToStaticMarkup(React.createElement(ReactMarkdown, { components: safeComponents }, source))

describe('markdown images', () => {
  it('are never an <img>: the alt text and the address are shown as text, and nothing is requested', () => {
    const out = html('Look: ![a diagram of a heap](https://tracker.example/pixel.png?q=secret) and ![](http://x.example/a.gif)')
    assert.doesNotMatch(out, /<img/i)
    assert.doesNotMatch(out, /<(a|link|source|picture|video|iframe)\b/i)
    assert.match(out, /a diagram of a heap/)
    assert.match(out, /\(https:\/\/tracker\.example\/pixel\.png\?q=secret\)/)
    assert.match(out, /Image/)
  })

  it('also covers reference-style images', () => {
    const out = html('![chart][c]\n\n[c]: https://tracker.example/c.png')
    assert.doesNotMatch(out, /<img/i)
    assert.match(out, /https:\/\/tracker\.example\/c\.png/)
  })

  it('are what the shared renderer uses', () => {
    // markdown.tsx imports stylesheets, which this runner cannot load, so check that the renderer spreads these in.
    const source = readFileSync(path.resolve(__dirname, '../../components/ui/markdown.tsx'), 'utf8')
    assert.match(source, /from '@\/lib\/markdown\/safe-components'/)
    assert.match(source, /\.\.\.safeComponents/)
  })
})
