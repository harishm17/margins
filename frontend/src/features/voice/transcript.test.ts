import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranscriptEntry } from './session-state'
import { Transcript } from './transcript'

const coach = (id: number, text: string, streaming = false): TranscriptEntry => ({ id, role: 'coach', text, streaming, interrupted: false })
const student = (id: number, text: string): TranscriptEntry => ({ id, role: 'student', text, via: 'voice' })

const render = (entries: TranscriptEntry[], interim: string, announce: boolean) =>
  renderToStaticMarkup(React.createElement(Transcript, { entries, interim, announce }))
const announced = (html: string) => /data-testid="voice-announcer">([^<]*)</.exec(html)?.[1]

describe('what a screen reader is told during a voice session', () => {
  const entries = [coach(1, 'What is entropy?'), student(2, 'a measure of disorder'), coach(3, 'Good. And why', true)]

  it('is not the reply as it streams, nor the words being recognised (both were read out on top of the spoken reply)', () => {
    const html = render(entries, 'it never', true)
    // The log is not a live region: a reply that grows word by word is not read piece by piece.
    assert.match(html, /role="log"[^>]*aria-live="off"/)
    // The student's own words, as the recogniser hears them, are hidden from the reader.
    assert.match(html, /<li[^>]*aria-hidden="true"[^>]*>(?:(?!<\/li>).)*it never/)
    // Nothing is announced while the reply is still arriving.
    assert.equal(announced(html), '')
  })

  it('is each complete reply once, and nothing when the app reads the reply aloud itself', () => {
    const done = [...entries.slice(0, 2), coach(3, 'Good. And why does it never decrease?')]
    assert.equal(announced(render(done, '', true)), 'Good. And why does it never decrease?')
    // Speech is on: the student hears the coach, and there is no second reading.
    assert.equal(announced(render(done, '', false)), undefined)
  })
})
