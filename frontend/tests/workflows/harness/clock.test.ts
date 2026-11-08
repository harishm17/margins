import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shiftStatements, type TimeColumns } from './clock'

const columns: TimeColumns = [
  { table: 'review_schedules', owners: ['user_id', 'project_id', 'topic_id'], times: ['due_at', 'last_reviewed_at'] },
  { table: 'concepts', owners: ['project_id', 'topic_id'], times: ['created_at'] },
  { table: 'topic_quizzes', owners: ['topic_id'], times: ['created_at'] },
  { table: 'projects', owners: ['user_id'], times: ['created_at', 'exam_date'] },
  { table: 'users', owners: [], times: ['created_at'] },
  { table: 'concept_memories', owners: ['user_id'], times: ['due_at'], cards: ['card'] },
  { table: 'ai_status', owners: [], times: ['checked_at'] },
]

describe('a day passing for one student', () => {
  it("moves the student's own rows back by the days, and nobody else's", () => {
    const statements = shiftStatements(columns, 2)
    assert.ok(
      statements.includes(
        `UPDATE "review_schedules" SET "due_at" = "due_at" - interval '2 days', "last_reviewed_at" = "last_reviewed_at" - interval '2 days' WHERE "user_id" = $1`
      )
    )
  })

  it("reaches rows that belong to the student's courses or topics", () => {
    const statements = shiftStatements(columns, 1)
    assert.ok(
      statements.includes(
        `UPDATE "concepts" SET "created_at" = "created_at" - interval '1 days' WHERE "project_id" IN (SELECT "id" FROM "projects" WHERE "user_id" = $1)`
      )
    )
    assert.ok(
      statements.includes(
        `UPDATE "topic_quizzes" SET "created_at" = "created_at" - interval '1 days' WHERE "topic_id" IN (SELECT t."id" FROM "topics" t JOIN "projects" p ON p."id" = t."project_id" WHERE p."user_id" = $1)`
      )
    )
  })

  it('keeps the exam date the student chose: it is a day on the calendar, so it comes one day nearer', () => {
    const projects = shiftStatements(columns, 1).find((statement) => statement.startsWith('UPDATE "projects"'))
    assert.equal(projects, `UPDATE "projects" SET "created_at" = "created_at" - interval '1 days' WHERE "user_id" = $1`)
  })

  it('moves the student themselves, and leaves shared tables alone', () => {
    const statements = shiftStatements(columns, 1)
    assert.ok(statements.includes(`UPDATE "users" SET "created_at" = "created_at" - interval '1 days' WHERE "id" = $1`))
    assert.ok(!statements.some((statement) => statement.includes('"ai_status"')))
  })

  it("moves the dates inside a memory's scheduling card in the same statement as its columns", () => {
    const memories = shiftStatements(columns, 3).find((statement) => statement.startsWith('UPDATE "concept_memories"')) ?? ''
    assert.match(memories, /^UPDATE "concept_memories" SET "due_at" = "due_at" - interval '3 days', "card" = .+ WHERE "user_id" = \$1$/)
    assert.match(memories, /'\{due\}'/)
    assert.match(memories, /'\{last_review\}'/)
    // A card without one of the dates keeps its value: jsonb_set with a null value would blank the whole card.
    assert.match(memories, /ELSE/)
  })

  it('refuses a fraction or a step back in time', () => {
    assert.throws(() => shiftStatements(columns, 0.5))
    assert.throws(() => shiftStatements(columns, -1))
  })
})

