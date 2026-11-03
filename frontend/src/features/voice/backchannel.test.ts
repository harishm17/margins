import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isBackchannel } from './backchannel'

describe('isBackchannel', () => {
  it('knows the backchannels from the spec', () => {
    for (const text of ['yeah', 'yes', 'mm-hm', 'uh-huh', 'okay', 'ok', 'right', 'sure', 'got it', 'I see']) {
      assert.equal(isBackchannel(text), true, text)
    }
  })

  it('ignores case, punctuation and recognizer spelling', () => {
    for (const text of ['Yeah.', 'OK!', 'Mm-hmm', 'mhm', 'uh huh', 'Okay, okay', 'yeah yeah yeah', 'Got it, I see', 'Yes, sure', "I've", 'All right']) {
      assert.equal(isBackchannel(text), text !== "I've", text)
    }
  })

  it('is not a backchannel when there is a real word in it', () => {
    for (const text of ['yeah but wait', 'no', 'stop', 'wait', 'okay so what is a hash', 'can you repeat that', 'I see the problem is', 'right answer']) {
      assert.equal(isBackchannel(text), false, text)
    }
  })

  it('is not a backchannel with nothing in it or a long run', () => {
    assert.equal(isBackchannel(''), false)
    assert.equal(isBackchannel('...'), false)
    assert.equal(isBackchannel('yeah yeah yeah yeah yeah yeah yeah'), false)
  })
})
