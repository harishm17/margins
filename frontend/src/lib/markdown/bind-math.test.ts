import assert from 'node:assert/strict'
import test from 'node:test'
import { rehypeBindMathPunctuation, type HastNode } from './bind-math'

const text = (value: string): HastNode => ({ type: 'text', value })
const math = (): HastNode => ({ type: 'element', tagName: 'span', properties: { className: ['katex'] }, children: [text('x')] })
const paragraph = (...children: HastNode[]): HastNode => ({ type: 'element', tagName: 'p', children })

const run = (tree: HastNode) => {
  rehypeBindMathPunctuation()(tree)
  return tree
}

const bound = (node: HastNode) => node.type === 'element' && Array.isArray(node.properties?.className) && (node.properties.className as string[]).includes('math-bind')

test('a full stop after a formula goes into the same no-wrap span', () => {
  const tree = run(paragraph(text('The payoff is '), math(), text('. Next sentence.')))
  const [before, wrapper, after] = tree.children!
  assert.equal(before.value, 'The payoff is ')
  assert.ok(bound(wrapper))
  assert.deepEqual(wrapper.children!.map((child) => child.value ?? 'katex'), ['katex', '.'])
  assert.equal(after.value, ' Next sentence.')
})

test('display math is not touched', () => {
  const display: HastNode = { type: 'element', tagName: 'span', properties: { className: ['katex-display'] }, children: [math()] }
  const tree = run(paragraph(text('before'), display, text('.')))
  assert.equal(JSON.stringify(tree).includes('math-bind'), false)
})
