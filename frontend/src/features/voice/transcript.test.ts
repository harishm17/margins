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

describe("a coach turn that reads out the question on the board (finding 86: on a phone it pushed the coach's words out of view)", () => {
  const asked = {
    text: "Two students run the same algorithm on the same input. According to the course, what should be used instead to describe the algorithm's efficiency?",
    options: [{ text: 'The measured time on the fastest available machine' }, { text: 'The number of lines of code as a function of input size' }],
  }
  const reply =
    "Not quite, it's C. Here's question two: Two students run the same algorithm on the same input. According to the course, what should be used instead to describe the algorithm's efficiency? The options are: A, the measured time on the fastest available machine. B, the number of lines of code as a function of input size. Take your time."
  const turn = (text: string, streaming = false): TranscriptEntry => ({ id: 1, role: 'coach', text, streaming, interrupted: false, asked })
  const shownText = (html: string) => html.replace(/<div class="sr-only"[^]*?<\/div>/, '').replace(/<[^>]+>/g, '').replaceAll('&#x27;', "'")

  it("shows the reading as one line, keeps the coach's own words, and still tells a screen reader the whole reply", () => {
    const html = render([turn(reply)], '', true)
    assert.match(shownText(html), /^Coach\s*Not quite, it's C\. Here's question two: The question on the board, read out\. Show Take your time\.$/)
    assert.equal(announced(html)?.includes('fastest available machine'), true)
  })

  it('folds the reading from its start while the reply is still arriving', () => {
    const html = render([turn("Here's question two: Two students run the same algorithm on the same input. According to", true)], '', false)
    assert.doesNotMatch(shownText(html), /same input/)
  })

  it('shows a reply whole when the reading does not match the question (a reworded question hides nothing)', () => {
    const reworded = "Here's question two: two students time the same program. One laptop is quicker. What describes its efficiency?"
    assert.match(shownText(render([turn(reworded)], '', false)), /One laptop is quicker/)
  })
})
