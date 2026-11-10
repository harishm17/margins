import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hasStudyData, rankWeakestTopics, type RankableTopic } from './voice-rank'

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
