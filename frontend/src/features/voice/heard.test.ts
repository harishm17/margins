import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHeardTracker, wordEnd } from './heard'

describe('createHeardTracker', () => {
  it('is empty before anything plays', () => {
    const heard = createHeardTracker()
    assert.equal(heard.text(), '')
    assert.equal(heard.any, false)
  })

  it('counts the finished sentences and the one that was cut off', () => {
    const heard = createHeardTracker()
    heard.start('Good start.', 'Good start.')
    heard.finish()
    heard.start('Now, what happens when two keys collide?', 'Now, what happens when two keys collide?')
    // Cut off: no boundary events, so the whole sentence counts.
    assert.equal(heard.text(), 'Good start. Now, what happens when two keys collide?')
    assert.equal(heard.any, true)
  })

  it('cuts the sentence at the word the voice had reached, when the voice says so', () => {
    const heard = createHeardTracker()
    heard.start('Now, what happens when two keys collide?', 'Now, what happens when two keys collide?')
    heard.boundary(0)
    heard.boundary(5)
    heard.boundary(11)
    assert.equal(heard.text(), 'Now, what happens')
  })

  it('does not cut by position when the spoken text differs from the screen text', () => {
    const heard = createHeardTracker()
    heard.start('The area is $x^2$ here.', 'The area is x squared here.')
    heard.boundary(12)
    assert.equal(heard.text(), 'The area is $x^2$ here.')
  })

  it('leaves out sentences that never started and sentences the browser could not say', () => {
    const heard = createHeardTracker()
    heard.start('First.', 'First.')
    heard.finish()
    heard.start('Broken.', 'Broken.')
    heard.abandon()
    assert.equal(heard.text(), 'First.')
  })

  it('starts over with reset', () => {
    const heard = createHeardTracker()
    heard.start('One.', 'One.')
    heard.finish()
    heard.reset()
    assert.equal(heard.text(), '')
    assert.equal(heard.any, false)
  })
})

describe('wordEnd', () => {
  it('finds the end of the word at an index', () => {
    assert.equal(wordEnd('hello big world', 0), 5)
    assert.equal(wordEnd('hello big world', 6), 9)
    assert.equal(wordEnd('hello big world', 12), 15)
    assert.equal(wordEnd('hello', 99), 5)
  })
})
