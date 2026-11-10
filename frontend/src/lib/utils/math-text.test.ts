import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { protectMathText } from './math-text'

/** Renders the way the app does, after the same preprocessing. */
function render(source: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath],
        rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: 'ignore' }]],
      },
      protectMathText(source)
    )
  )
}

const visibleText = (html: string) =>
  html
    .replace(/<math[\s\S]*?<\/math>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\u200b/g, '')

test('real math is left exactly as written', () => {
  for (const text of [
    '$x = 5$',
    '$10^6$',
    '$P(A)=0.4$',
    '$5$ and $6$',
    '$2x + 3 = 11$ so $x = 4$',
    'We get $\\frac{1}{36}$ and $$\\sum_{i=1}^{6} i = 21$$.',
    '$sin x$ and $cos x$',
    '$\\text{Game } Y$',
    '$3 \\cdot 4 = 12$',
  ]) {
    assert.equal(protectMathText(text), text, text)
  }
})

test('currency in the audit strings stays currency', () => {
  assert.equal(protectMathText('$500 if i + j = 7 and -$100 otherwise'), '\\$500 if i + j = 7 and -\\$100 otherwise')
  assert.equal(protectMathText('It costs $5 and $10 each.'), 'It costs \\$5 and \\$10 each.')
  assert.equal(protectMathText('Pay $100.'), 'Pay \\$100.')
  assert.equal(
    protectMathText('You win $500 if the sum is 7 and lose $100 otherwise.'),
    'You win \\$500 if the sum is 7 and lose \\$100 otherwise.'
  )
})

test('an escaped dollar inside a math span no longer ends the span', () => {
  assert.equal(protectMathText('$-\\$100$'), '$-\\char"24 100$')
  const html = render('pays \\$500 if $i+j=7$ and $-\\$100$ otherwise')
  assert.ok(!html.includes('katex-error'), html)
  assert.match(visibleText(html), /pays \$500 if i\+j=7 and −\$100 otherwise/)
})

test('currency next to real math renders both', () => {
  const html = render('The game costs $5 to play and pays $x$ dollars with $P(x)=0.4$.')
  assert.ok(!html.includes('katex-error'), html)
  const text = visibleText(html)
  assert.ok(text.includes('costs $5 to play'), text)
  assert.ok(text.includes('P(x)=0.4'), text)
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2)
})

test('code and display math are not touched', () => {
  const text = 'Use `$5 and $6` here.\n\n```python\nprice = "$5 and $6"\n```\n\n$$\nx = \\$5\n$$'
  assert.equal(protectMathText(text), text)
})

test('a formula alone on its line becomes display math, one in a sentence stays inline', () => {
  assert.equal(protectMathText('Intro\n\n$$S = x$$\n\nafter'), 'Intro\n\n$$\nS = x\n$$\n\nafter')
  assert.equal(protectMathText('$$a+b$$'), '$$\na+b\n$$')
  assert.equal(protectMathText('so $$x$$ holds'), 'so $$x$$ holds')
  assert.equal(protectMathText('- $$x$$'), '- $$x$$')
  assert.equal(protectMathText('$$\nalready\n$$'), '$$\nalready\n$$')
  assert.ok(render('Intro\n\n$$S = x$$\n\nafter').includes('katex-display'))
})
