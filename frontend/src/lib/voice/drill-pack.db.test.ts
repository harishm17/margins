/**
 * The voice sprint pack against a real, migrated Postgres (DATABASE_URL). Skipped when no database with the topics
 * table answers.
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let pack: typeof import('./drill-pack')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  pack = await import('./drill-pack')
  available = await prisma.$queryRaw`SELECT 1 FROM topics LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

const dbTest = (name: string, fn: () => Promise<void>) => test(name, async (t) => (available ? fn() : t.skip('no database')))

dbTest('topics that tie for the sprint are taken in course order, whatever order they were written in', async () => {
  const user = await prisma.user.create({ data: { email: `sprint-tie-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  // None opened yet, so all four tie; written last topic first.
  const names = ['Sorting', 'Hashing', 'Trees', 'Graphs']
  const ids = new Map<string, string>()
  for (const [orderIndex, name] of [...names.entries()].reverse()) {
    const topic = await prisma.topic.create({ data: { projectId: project.id, name, orderIndex, userConfirmed: true } })
    ids.set(topic.id, name)
    await prisma.topicContent.create({
      data: { topicId: topic.id, contentType: 'topic_quiz', contentData: { questions: [{ question_type: 'conceptual', question_text: `Why does ${name} matter?`, sample_answer: 'It keeps the invariant.' }] } },
    })
  }

  const questions = await pack.buildSprintQuestionSet(project.id, user.id)
  assert.deepEqual(
    questions.map((q) => ids.get(q.topic_id ?? '')),
    ['Sorting', 'Hashing', 'Trees']
  )
})

dbTest('Quiz me keeps the questions of earlier sets when a newer set is written, newest first (finding 81)', async () => {
  const user = await prisma.user.create({ data: { email: `pool-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Sorting', orderIndex: 0, userConfirmed: true } })
  const ask = (text: string) => ({ question_type: 'conceptual', question_text: text, sample_answer: 'Because the invariant holds.' })
  const first = [ask('Why is merge sort stable?'), ask('What does the merge step assume?'), ask('When is insertion sort the better choice?')]
  // The "Fix it now" set: one question that can be asked aloud, one that is working. It becomes the topic's quiz.
  const fix = [ask('What breaks stability in quicksort?'), { question_type: 'numerical', question_text: 'Compute 7 * 8 comparisons', sample_answer: '56' }]
  await prisma.topicQuiz.create({ data: { topicId: topic.id, questions: first, createdAt: new Date(Date.now() - 60_000) } })
  await prisma.topicQuiz.create({ data: { topicId: topic.id, questions: fix } })
  await prisma.topicContent.create({ data: { topicId: topic.id, contentType: 'topic_quiz', contentData: { questions: fix } } })

  const questions = await pack.buildTopicQuestionSet(topic.id, user.id)
  assert.deepEqual(
    questions.map((q) => q.question_text),
    ['What breaks stability in quicksort?', 'Why is merge sort stable?', 'What does the merge step assume?', 'When is insertion sort the better choice?']
  )

  // The quick round's lobby states the size the round has (finding 83).
  const preview = await pack.sprintPreview(project.id, user.id)
  assert.equal(preview.ready, (await pack.buildSprintQuestionSet(project.id, user.id)).length)
  assert.equal(preview.ready, 4)
  assert.deepEqual(preview.writes, [])
})
