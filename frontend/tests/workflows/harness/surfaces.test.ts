import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { disagreements, masteryOf, minutesOf, notStartedName, percentShown, planItemReading, stepOf } from './surfaces'

describe('reading a surface', () => {
  it('names the study step a phrase points to', () => {
    assert.equal(stepOf('Next: Read'), 'Read')
    assert.equal(stepOf('Start reading'), 'Read')
    assert.equal(stepOf('Read the topic next.'), 'Read')
    assert.equal(stepOf('Read (next up)'), 'Read')
    assert.equal(stepOf('Margins gets this topic ready when you open it, then starts you on a short warm-up.'), 'Warm-up')
    assert.equal(stepOf('Next: Practise the gap'), 'Practice')
    assert.equal(stepOf('Recall (next up) 2/6'), 'Recall')
    assert.equal(stepOf('Your first quiz on this topic.'), 'Quiz')
    assert.equal(stepOf('A short check before it fades, mastery 0%.'), undefined)
    assert.equal(stepOf('Pick up where you stopped.'), undefined)
  })

  it('reads topic progress as its band and the percent when one is shown', () => {
    assert.equal(masteryOf('Topic progress Learning 0% About 20 min'), 'Learning 0%')
    assert.equal(masteryOf('Topic progress: Learning'), 'Learning')
    assert.equal(masteryOf('0% Sorting and searching Learning'), 'Learning 0%')
    assert.equal(masteryOf('-- Hash tables Not started'), 'Not started')
    assert.equal(masteryOf('Learning, 28%'), 'Learning 28%')
    assert.equal(masteryOf('Just started'), 'Just started')
    assert.equal(masteryOf('A short check before it fades, mastery 0%.'), '0%')
    assert.equal(masteryOf('Read the topic next.'), undefined)
  })

  it('reads the minutes a surface gives', () => {
    assert.equal(minutesOf('About 20 min'), 20)
    assert.equal(minutesOf('Part 1 of 2, 15 min'), 15)
    assert.equal(minutesOf('Topic progress Learning 0% About 20 min'), 20)
    assert.equal(minutesOf('Learn Sorting and Searching · 20 of 45 min'), 20)
    assert.equal(minutesOf('Read the topic next.'), undefined)
  })
})

describe('disagreements', () => {
  const readings = [
    { surface: 'topics list', next: 'Read', mastery: 'Learning' },
    { surface: 'topic header', next: 'Read', mastery: 'Learning 0%', minutes: 20 },
    { surface: 'home', next: 'Read', minutes: 20 },
    { surface: 'plan', mastery: '0%', minutes: 15 },
  ]

  it('is empty when every surface that shows a value shows the same one', () => {
    assert.deepEqual(disagreements(readings, 'next'), [])
  })

  it('lets one surface show the band, another the percent, and a third both', () => {
    assert.deepEqual(disagreements(readings, 'mastery'), [])
  })

  it('quotes the words a surface used for its next step', () => {
    const said = [
      { surface: 'topics list', next: 'Read', said: 'Next: Re-read the gap' },
      { surface: 'topic header', next: 'Recall' },
    ]
    assert.deepEqual(disagreements(said, 'next'), ['topics list: Read ("Next: Re-read the gap"); topic header: Recall'])
  })

  it('names each surface and what it shows when they differ', () => {
    assert.deepEqual(disagreements(readings, 'minutes'), ['topic header: 20; home: 20; plan: 15'])
    const bands = [...readings, { surface: 'sidebar', mastery: 'Not started' }]
    assert.deepEqual(disagreements(bands, 'mastery'), ['topics list: Learning; topic header: Learning 0%; plan: 0%; sidebar: Not started'])
    const percents = [...readings, { surface: 'sidebar', mastery: 'Learning 7%' }]
    assert.deepEqual(disagreements(percents, 'mastery'), ['topics list: Learning; topic header: Learning 0%; plan: 0%; sidebar: Learning 7%'])
  })
})

describe('percent before evidence', () => {
  it('lists the surfaces that show a percent', () => {
    const readings = [
      { surface: 'topics list', mastery: 'Learning' },
      { surface: 'topic header', mastery: 'Learning 0%' },
      { surface: 'home' },
    ]
    assert.deepEqual(percentShown(readings), ['topic header: Learning 0%'])
  })
})

describe('a plan item', () => {
  const topic = 'Sorting and searching'

  it('reads the step its reason names, its minutes and any mastery', () => {
    assert.deepEqual(planItemReading([`Learn ${topic}`, 'Read the topic next.', '20 min'], topic, false), {
      surface: 'plan',
      next: 'Read',
      said: 'Read the topic next.',
      mastery: undefined,
      minutes: 20,
    })
    assert.equal(planItemReading([`Review ${topic}`, 'A short check before it fades, mastery 0%.', '10 min'], topic, false).mastery, '0%')
  })

  it('takes a ticked "Learn" item to say nothing is left for the topic today', () => {
    const reading = planItemReading([`Learn ${topic}`, 'Read the topic next.', '20 min'], topic, true)
    assert.equal(reading.next, 'nothing')
    assert.equal(reading.said, `Learn ${topic}, ticked done`)
  })

  it('takes a ticked single step (a quiz, a review) to say only that it was done', () => {
    const reading = planItemReading([`Quiz: ${topic}`, 'Your first quiz on this topic.', '15 min'], topic, true)
    assert.equal(reading.next, undefined)
    assert.equal(reading.said, `Quiz: ${topic}, ticked done`)
  })
})

describe('topics the student never opened', () => {
  // A row of the topics list: its link (name, next step, status) and its details button, which names the topic.
  const row = (status: string) => `Hash tables, chaining\nOn past exams\nNext: Warm-up\nTopic progress: \n${status}\nDue today`

  it('reads the topic from its details button when the status says "Not started"', () => {
    assert.equal(notStartedName('Show details: Hash tables, chaining', row('Not started')), 'Hash tables, chaining')
    assert.equal(notStartedName('Hide details: Hash tables, chaining', row('Not started')), 'Hash tables, chaining')
  })

  it('skips a topic that was opened', () => {
    assert.equal(notStartedName('Show details: Hash tables, chaining', row('In progress')), null)
    assert.equal(notStartedName('Show details: Hash tables, chaining', row('Learning')), null)
  })
})
