import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { firstOf, mainScreens, missable, probeOffsets } from './devices'

describe('where a finger must land for a 44 px target (SW5)', () => {
  it('is the middle of each side of a 44 px square around the centre', () => {
    assert.deepEqual(probeOffsets(), [
      [-21.5, 0],
      [21.5, 0],
      [0, -21.5],
      [0, 21.5],
    ])
  })

  it('scales with the size asked for', () => {
    assert.deepEqual(probeOffsets(24)[1], [11.5, 0])
  })
})

describe('a long list in a check message', () => {
  it('keeps a short list whole', () => {
    assert.deepEqual(firstOf(['a', 'b'], 3), ['a', 'b'])
  })

  it('cuts a long list and says how many more', () => {
    assert.deepEqual(firstOf(['a', 'b', 'c', 'd'], 2), ['a', 'b', 'and 2 more'])
  })
})

describe('the main screens', () => {
  it('cover the course, the topic views and Settings, each once', () => {
    const screens = mainScreens('/courses/c1', '/courses/c1/topics/t1')
    assert.equal(new Set(screens.map(([name]) => name)).size, screens.length)
    assert.ok(screens.some(([, url]) => url === '/courses/c1/topics/t1?view=practice'))
    assert.ok(screens.some(([, url]) => url === '/settings'))
  })
})

describe('whether a finger can miss a control (SW5)', () => {
  const probe = (over: Partial<{ inside: boolean; offScreen: boolean; hitOwn: boolean }>) => ({ inside: false, offScreen: false, hitOwn: false, ...over })

  it('cannot when every probe point lands in its own box, even under a bar laid over it', () => {
    assert.equal(missable([probe({ inside: true }), probe({ inside: true }), probe({ inside: true }), probe({ inside: true })]), false)
  })

  it('cannot when a point outside the box still hits it: a wider hit area', () => {
    assert.equal(missable([probe({ hitOwn: true }), probe({ hitOwn: true }), probe({ inside: true }), probe({ inside: true })]), false)
  })

  it('cannot when a point is off the screen: the edge stops the finger', () => {
    assert.equal(missable([probe({ offScreen: true }), probe({ inside: true }), probe({ inside: true }), probe({ inside: true })]), false)
  })

  it('can when a point outside its box hits something else', () => {
    assert.equal(missable([probe({ inside: true }), probe({ inside: true }), probe({}), probe({ inside: true })]), true)
  })
})
