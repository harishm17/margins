import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { endOfTurnWaitMs } from './end-of-turn'
import {
  createUtteranceCollector,
  idleAction,
  isEcho,
  type SpeechResult,
  type Timers,
} from './silence'

/** A clock the test moves by hand. */
function fakeTimers() {
  let now = 0
  let nextId = 1
  const scheduled = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set(fn, ms) {
      const id = nextId++
      scheduled.set(id, { at: now + ms, fn })
      return id
    },
    clear(handle) {
      scheduled.delete(handle as number)
    },
  }
  return {
    timers,
    pending: () => scheduled.size,
    advance(ms: number) {
      const target = now + ms
      while (true) {
        const due = [...scheduled.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        scheduled.delete(due[0])
        due[1].fn()
      }
      now = target
    },
  }
}

const final = (transcript: string): SpeechResult => ({ transcript, isFinal: true })
const interim = (transcript: string): SpeechResult => ({ transcript, isFinal: false })

function setup() {
  const clock = fakeTimers()
  const commits: string[] = []
  const interims: string[] = []
  const collector = createUtteranceCollector({
    timers: clock.timers,
    onCommit: (text) => commits.push(text),
    onInterim: (text) => interims.push(text),
  })
  return { clock, commits, interims, collector }
}

describe('createUtteranceCollector', () => {
  it('commits a final result after the short-answer wait of 1.2 s, not before', () => {
    const { clock, commits, collector } = setup()
    collector.update([final('a hash function maps keys')])
    clock.advance(1199)
    assert.deepEqual(commits, [])
    clock.advance(1)
    assert.deepEqual(commits, ['a hash function maps keys'])
  })

  it('restarts the wait when a new result arrives and joins the final segments', () => {
    const { clock, commits, collector } = setup()
    collector.update([final('a hash function')])
    clock.advance(1000)
    collector.update([final('a hash function'), final('maps a key to a bucket')])
    clock.advance(1000)
    assert.deepEqual(commits, [])
    clock.advance(200)
    assert.deepEqual(commits, ['a hash function maps a key to a bucket'])
  })

  it('waits while the recognizer still reports interim text', () => {
    const { clock, commits, interims, collector } = setup()
    collector.update([final('because it visits'), interim('nodes in order')])
    clock.advance(1500)
    assert.deepEqual(commits, [])
    assert.equal(interims.at(-1), 'because it visits nodes in order')
    collector.update([final('because it visits nodes in order')])
    clock.advance(1200)
    assert.deepEqual(commits, ['because it visits nodes in order'])
  })


  it('commits an interim result that never finalises, after the stale wait', () => {
    const { clock, commits, collector } = setup()
    collector.update([interim('stuck phrase')])
    clock.advance(2499)
    assert.deepEqual(commits, [])
    clock.advance(1)
    assert.deepEqual(commits, ['stuck phrase'])
  })

  it('does not commit the same words twice and keeps counting from the committed length', () => {
    const { clock, commits, collector } = setup()
    collector.update([final('first answer')])
    clock.advance(1200)
    collector.update([final('first answer'), final('second answer')])
    clock.advance(1200)
    assert.deepEqual(commits, ['first answer', 'second answer'])
  })
})

describe('the adaptive wait', () => {
  function adaptive(listenFor: () => 'short_answer' | 'explanation') {
    const clock = fakeTimers()
    const commits: { text: string; waitedMs: number; early: boolean }[] = []
    const holds: boolean[] = []
    let at = 0
    const collector = createUtteranceCollector({
      timers: clock.timers,
      now: () => at,
      waitMs: ({ text }) => endOfTurnWaitMs({ listenFor: listenFor(), text }),
      onCommit: (text, info) => commits.push({ text, ...info }),
      onHold: (holding) => holds.push(holding),
    })
    return {
      collector,
      commits,
      holds,
      advance(ms: number) {
        clock.advance(ms)
        at += ms
      },
    }
  }

  it('waits longer for an explanation than for a short answer', () => {
    const quick = adaptive(() => 'short_answer')
    quick.collector.update([final('it is a stack')])
    quick.advance(1200)
    assert.equal(quick.commits.length, 1)

    const long = adaptive(() => 'explanation')
    long.collector.update([final('it is a stack')])
    long.advance(2199)
    assert.equal(long.commits.length, 0)
    long.advance(1)
    assert.equal(long.commits[0].text, 'it is a stack')
    assert.equal(long.commits[0].early, false)
  })

  it('holds the turn when the last word is a continuation word, up to the cap', () => {
    const { collector, commits, advance } = adaptive(() => 'explanation')
    collector.update([final('it works by going to the')])
    advance(3699)
    assert.equal(commits.length, 0)
    advance(1)
    assert.equal(commits.length, 1)
    // Never past 4 s, even for stale interim text.
    const stale = adaptive(() => 'explanation')
    stale.collector.update([interim('it works by going to the')])
    stale.advance(3699)
    assert.equal(stale.commits.length, 0)
    stale.advance(1)
    assert.equal(stale.commits.length, 1)
  })

})

describe('isEcho', () => {
  const spoken = 'Right. Each level is one step further from the start, so BFS finds the shortest path.'

  it('spots a fragment of the coach text', () => {
    assert.equal(isEcho('each level is one step', spoken), true)
    assert.equal(isEcho('Shortest path.', spoken), true)
  })

  it('lets a real interruption through', () => {
    assert.equal(isEcho('wait can you repeat the question', spoken), false)
    assert.equal(isEcho('stop', spoken), false)
  })

})

describe('idleAction', () => {
  const base = { inputMode: 'voice' as const, gentleShown: false, waitingForAnswer: true }

  it('gives a silent voice student one gentle line, and not before 10 s', () => {
    assert.equal(idleAction({ ...base, idleMs: 0 }), 'none')
    assert.equal(idleAction({ ...base, idleMs: 9_999 }), 'none')
    assert.equal(idleAction({ ...base, idleMs: 10_000 }), 'gentle')
    assert.equal(idleAction({ ...base, idleMs: 30_000 }), 'gentle')
  })


  it('ends the session after two minutes of silence', () => {
    assert.equal(idleAction({ ...base, idleMs: 119_999, gentleShown: true }), 'none')
    assert.equal(idleAction({ ...base, idleMs: 120_000, gentleShown: true }), 'end')
    assert.equal(idleAction({ ...base, idleMs: 120_000, waitingForAnswer: false }), 'end')
  })
})
