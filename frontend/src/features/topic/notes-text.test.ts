import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanNotes, readMinutes } from './notes-text'

test('removes inline citation tags', () => {
  assert.equal(
    cleanNotes('## A\n\nBFS uses a queue [Citation: week2.pdf, p. 4]. Done.'),
    '## A\n\nBFS uses a queue. Done.'
  )
})

test('removes "If you want, I can" lines and the list under them', () => {
  const out = cleanNotes('## A\n\nText.\n\nIf you want, I can:\n- make a quiz\n- write more\n\n## B\n\nMore.')
  assert.ok(!/if you want/i.test(out))
  assert.ok(!out.includes('make a quiz'))
  assert.ok(out.includes('## B'))
})

test('promotes the lesson labels and leaves check blocks alone', () => {
  const out = cleanNotes("What you'll learn\n- sort things\n\nThe idea\nCompare and swap.\n\nCheck yourself\n```check\nQ: Why?\nA: Because.\n```")
  assert.ok(out.includes("## What you'll learn"))
  assert.ok(out.includes('## The idea'))
  assert.ok(out.includes('## Check yourself'))
  assert.ok(out.includes('```check\nQ: Why?\nA: Because.\n```'))
})
