import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'
import { CREDIT_URL } from './site'

it('links the footer credit to the author site with the margins ref tag', () => {
  assert.equal(CREDIT_URL, 'https://harishmanoharan.com/?ref=margins')
  const footer = readFileSync(join(__dirname, '..', 'app', '(marketing)', 'layout.tsx'), 'utf8')
  assert.match(footer, /Built by\{' '\}\s*<a href=\{CREDIT_URL\}/)
})
