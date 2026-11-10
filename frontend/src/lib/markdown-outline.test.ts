import test from 'node:test'
import assert from 'node:assert/strict'
import { createSlugger, extractOutline } from './markdown-outline'

test('slugger numbers repeats', () => {
  const slug = createSlugger()
  assert.deepEqual([slug('Overview'), slug('Overview'), slug('Overview')], ['overview', 'overview-1', 'overview-2'])
})

test('extractOutline skips code fences and deeper headings', () => {
  const source = ['# Graphs', '## Overview', 'text', '```python', '## not a heading', '```', '### Detail', '## **Key** concepts'].join('\n')
  assert.deepEqual(extractOutline(source), [
    { id: 'graphs', text: 'Graphs', level: 1 },
    { id: 'overview', text: 'Overview', level: 2 },
    { id: 'key-concepts', text: 'Key concepts', level: 2 },
  ])
})
