import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeSprintTopics, hasStudyData, rankWeakestTopics, type RankableTopic } from './voice-rank'

const done = { quizCompleted: true, notesCompleted: true, examplesCompleted: true }

const topic = (id: string, progress: RankableTopic['progress']): RankableTopic => ({ id, name: id.toUpperCase(), progress })

describe('rankWeakestTopics', () => {
  it('puts topics with no progress at the front, then the lowest scores', () => {
    const topics = [
      topic('strong', { quizScore: 95, ...done }),
      topic('fresh', null),
      topic('middling', { quizScore: 60, ...done }),
      topic('weak', { quizScore: 30, ...done }),
    ]
    assert.deepEqual(
      rankWeakestTopics(topics).map((t) => t.id),
      ['fresh', 'weak', 'middling']
    )
  })

  it('counts a topic with unfinished study steps 10 points lower', () => {
    const topics = [
      topic('finished', { quizScore: 55, ...done }),
      topic('unfinished', { quizScore: 60, quizCompleted: true, notesCompleted: false, examplesCompleted: true }),
    ]
    assert.deepEqual(
      rankWeakestTopics(topics, 2).map((t) => t.id),
      ['unfinished', 'finished']
    )
  })

  it('treats a missing quiz score as zero', () => {
    const topics = [topic('a', { quizScore: null, ...done }), topic('b', { quizScore: 10, ...done })]
    assert.deepEqual(
      rankWeakestTopics(topics).map((t) => t.id),
      ['a', 'b']
    )
  })

  it('keeps the input order for ties and returns fewer than three when there are fewer topics', () => {
    const topics = [topic('x', null), topic('y', null)]
    assert.deepEqual(
      rankWeakestTopics(topics).map((t) => t.id),
      ['x', 'y']
    )
    assert.deepEqual(rankWeakestTopics([]), [])
  })

  it('does not change the input', () => {
    const topics = [topic('b', { quizScore: 80, ...done }), topic('a', null)]
    rankWeakestTopics(topics)
    assert.deepEqual(
      topics.map((t) => t.id),
      ['b', 'a']
    )
  })
})

describe('describeSprintTopics', () => {
  it('names the topics and counts them once there are quiz scores', () => {
    assert.equal(describeSprintTopics([{ name: 'A' }, { name: 'B' }, { name: 'C' }], true), 'Covers your 3 weakest topics: A, B and C.')
    assert.equal(describeSprintTopics([{ name: 'A' }, { name: 'B' }], true), 'Covers your 2 weakest topics: A and B.')
    assert.equal(describeSprintTopics([{ name: 'A' }], true), 'Covers your weakest topic: A.')
    assert.equal(describeSprintTopics([], true), '')
  })

  it('does not call the topics weakest before any quiz', () => {
    assert.equal(
      describeSprintTopics([{ name: 'A' }, { name: 'B' }, { name: 'C' }], false),
      'Covers 3 of your topics: A, B and C. After your first quiz it picks your weakest.'
    )
    assert.equal(describeSprintTopics([{ name: 'A' }], false), 'Covers one of your topics: A. After your first quiz it picks your weakest.')
    assert.equal(describeSprintTopics([], false), '')
  })
})

describe('hasStudyData', () => {
  it('is true only when some topic has a quiz score', () => {
    const fresh = { quizScore: null, quizCompleted: false, notesCompleted: true, examplesCompleted: false }
    assert.equal(hasStudyData([]), false)
    assert.equal(hasStudyData([{ id: 'a', name: 'A', progress: null }]), false)
    assert.equal(hasStudyData([{ id: 'a', name: 'A', progress: fresh }]), false)
    assert.equal(
      hasStudyData([
        { id: 'a', name: 'A', progress: null },
        { id: 'b', name: 'B', progress: { ...fresh, quizScore: 0, quizCompleted: true } },
      ]),
      true
    )
  })
})
