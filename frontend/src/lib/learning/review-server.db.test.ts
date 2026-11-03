/**
 * The plan of a "Fix it now" review set, against a real, migrated Postgres (DATABASE_URL). Skipped
 * when no database with the concepts table answers.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./review-server')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./review-server')
  available = await prisma.$queryRaw`SELECT 1 FROM concepts LIMIT 1`.then(
    () => true,
    () => false
  )
})

test.after(async () => {
  if (!available) return
  await prisma.$disconnect()
})

test('fresh review focuses missed concept ids', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const user = await prisma.user.create({ data: { email: `fr-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const make = (name: string, orderIndex: number, status = 'active') =>
    prisma.concept.create({
      data: { projectId: project.id, topicId: topic.id, name, summary: `${name}.`, kind: 'concept', orderIndex, objectiveIndexes: [], status },
    })
  const [queues, stacks, gone] = [await make('Queues', 0), await make('Stacks', 1), await make('Retired idea', 2, 'removed')]
  const question = (text: string, ids: string[]) => ({
    question_type: 'true_false',
    question_text: text,
    correct_answer: true,
    concept_ids: ids,
    concepts_tested: ['Old label'],
  })
  const questions = [question('One', [queues.id, gone.id]), question('Two', [stacks.id]), question('Three', [queues.id])]
  const set = await prisma.topicQuiz.create({ data: { topicId: topic.id, questions } })
  await prisma.quizAttempt.create({
    data: {
      userId: user.id,
      topicId: topic.id,
      quizSetId: set.id,
      score: 0,
      answers: { '0': 'false', '1': 'false', '2': 'false' },
      results: Object.fromEntries([0, 1, 2].map((i) => [String(i), { isCorrect: false, pointsEarned: 0, pointsPossible: 1 }])),
    },
  })

  const plan = await mod.planFreshReview(user.id, { id: topic.id, projectId: project.id })
  assert.deepEqual(plan.conceptIds, [queues.id, stacks.id])
  assert.equal(plan.focus, 'Concepts you missed: Queues; Stacks')
  assert.deepEqual(mod.freshReviewPreferences(plan).concept_ids, [queues.id, stacks.id])
})
