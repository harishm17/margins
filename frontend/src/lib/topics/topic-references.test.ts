/**
 * The topic reference registry covers the schema (finding 78): a model with a topic column, a topic array or a scope key
 * has a merge rule and a delete rule, and a delete rule that says 'cascade' or 'keep' is what the schema does.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOPIC_REFERENCES } from './topic-references'

const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
const models = [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)].map((match) => ({ name: match[1], body: match[2] }))

/** Fields that name a topic: a topicId column, a topicIds or prerequisiteIds array, or a scopeKey. */
const FIELD = /^\s*(topicId|topicIds|prerequisiteIds|scopeKey)\s/gm
/** Json columns that hold topic ids (their schema comments say so). */
const JSON_WITH_TOPICS = [
  { model: 'SampleExam', column: 'questions' },
  { model: 'Material', column: 'examTopicMap' },
  { model: 'ProcessingJob', column: 'inputData' },
]

test('every model with a topic column, topic array or scope key has a registry entry', () => {
  const missing: string[] = []
  for (const { name, body } of models) {
    if (name === 'Topic') continue
    for (const match of body.matchAll(FIELD)) {
      if (!TOPIC_REFERENCES.some((entry) => entry.model === name && entry.column === match[1])) missing.push(`${name}.${match[1]}`)
    }
  }
  assert.deepEqual(missing, [], 'add these to TOPIC_REFERENCES in lib/topics/topic-references.ts with a merge and a delete rule')
  for (const { model, column } of JSON_WITH_TOPICS) assert.ok(TOPIC_REFERENCES.some((entry) => entry.model === model && entry.column === column), `${model}.${column}`)
})

test('the registry names real models and columns, and a move rule has code', () => {
  for (const entry of TOPIC_REFERENCES) {
    const model = models.find((item) => item.name === entry.model)
    assert.ok(model, `${entry.model} is not a model`)
    assert.ok(new RegExp(`^\\s*${entry.column}\\s`, 'm').test(model.body), `${entry.model}.${entry.column} is not a field`)
    if (entry.merge === 'move' && entry.column === 'topicId') assert.ok(entry.apply, `${entry.model} says move and has no code`)
  }
})

test('a delete rule matches the schema: cascade deletes the rows, keep clears the topic column', () => {
  for (const entry of TOPIC_REFERENCES) {
    if (entry.column !== 'topicId') continue
    const body = models.find((item) => item.name === entry.model)!.body
    const relation = /^\s*topic\s+Topic\??.*onDelete: (\w+)/m.exec(body)
    assert.ok(relation, `${entry.model} has a topicId column and no topic relation`)
    assert.equal(relation[1] === 'Cascade' ? 'cascade' : 'keep', entry.onDelete, `${entry.model}: the schema does ${relation[1]}`)
  }
})

test('a margin note outlives its topic', () => {
  assert.equal(TOPIC_REFERENCES.find((entry) => entry.model === 'MarginNote' && entry.column === 'topicId')?.onDelete, 'keep')
})
