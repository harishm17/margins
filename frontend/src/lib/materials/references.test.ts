/**
 * The schema-parsing guard for the references list (plan SW13). It reads prisma/schema.prisma and fails when a column
 * that can hold a pointer to a file or a chunk has no entry in references.ts, so an unlisted pointer cannot hide:
 * a `Json` column, an `*Ids String[]` column, a column named for a material or chunk, and the key columns that carry ids
 * (`scopeKey`, `targetKey`). It also fails when an entry has no rule, names a column that does not exist, or says a
 * foreign key does what the schema does not.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { NOT_REFERENCES, REFERENCES, RULES } from './references'

type Column = { model: string; field: string; type: string; line: string }

function parseSchema(): Column[] {
  const text = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const columns: Column[] = []
  let model: string | null = null
  for (const raw of text.split('\n')) {
    const open = raw.match(/^model (\w+) \{/)
    if (open) {
      model = open[1]
      continue
    }
    if (raw.startsWith('}')) model = null
    if (!model) continue
    const field = raw.match(/^\s+(\w+)\s+(\S+)/)
    if (!field || raw.trim().startsWith('//') || raw.trim().startsWith('@@')) continue
    columns.push({ model, field: field[1], type: field[2], line: raw })
  }
  return columns
}

const holdsPointer = (column: Column): boolean =>
  /^Json\??$/.test(column.type) ||
  (column.type === 'String[]' && column.field.endsWith('Ids')) ||
  /material_?id|chunk_?id/i.test(column.field) ||
  column.field === 'scopeKey' ||
  column.field === 'targetKey'

const name = (column: Column) => `${column.model}.${column.field}`

test('every column that can hold a file or chunk pointer is in references.ts (SW13)', () => {
  const listed = new Set([...REFERENCES.flatMap((entry) => entry.columns), ...Object.keys(NOT_REFERENCES)])
  const missing = parseSchema().filter(holdsPointer).map(name).filter((column) => !listed.has(column))
  assert.deepEqual(missing, [], 'add these columns to REFERENCES (with a rule) or to NOT_REFERENCES (with a reason) in lib/materials/references.ts')
})

test('references.ts names only columns that exist, and a column only once', () => {
  const schema = new Set(parseSchema().map(name))
  const names = [...REFERENCES.flatMap((entry) => entry.columns), ...Object.keys(NOT_REFERENCES)]
  assert.deepEqual(names.filter((column) => !schema.has(column)), [])
  assert.deepEqual(names.filter((column, index) => names.indexOf(column) !== index), [])
})

test('every reference has a rule for delete, replace, course delete and account delete', () => {
  for (const entry of REFERENCES) {
    assert.ok(RULES.includes(entry.onDelete), `${entry.id}: onDelete`)
    assert.ok(RULES.includes(entry.onReplace), `${entry.id}: onReplace`)
    assert.equal(entry.onCourseDelete, 'remove', `${entry.id}: onCourseDelete`)
    assert.equal(entry.onAccountDelete, 'remove', `${entry.id}: onAccountDelete`)
    assert.ok(entry.note.trim().length > 0, `${entry.id}: note`)
    if (entry.how === 'not-yet') assert.ok(entry.until?.reason, `${entry.id}: a rule not carried out yet needs a reason and the PR that does it`)
  }
  assert.equal(new Set(REFERENCES.map((entry) => entry.id)).size, REFERENCES.length)
  for (const [column, reason] of Object.entries(NOT_REFERENCES)) assert.ok(reason.trim(), `${column}: reason`)
})

test('the foreign keys do what the rules say', () => {
  const schema = parseSchema()
  for (const entry of REFERENCES) {
    if (entry.how === 'fk-cascade') assert.equal(entry.onDelete, 'remove', entry.id)
    if (entry.how === 'fk-set-null') assert.equal(entry.onDelete, 'keep-and-mark', entry.id)
    if (entry.onDelete === 'remove') assert.ok(['fk-cascade', 'explicit', 'not-yet'].includes(entry.how), `${entry.id}: a removed pointer is cleared by a cascade or by code`)
    if (entry.onDelete === 'keep-and-mark') assert.ok(['fk-set-null', 'left-in-place', 'not-yet'].includes(entry.how), `${entry.id}: a kept pointer is not cascaded`)
    if (entry.how !== 'fk-cascade' && entry.how !== 'fk-set-null') continue
    const wanted = entry.how === 'fk-cascade' ? 'Cascade' : 'SetNull'
    for (const column of entry.columns) {
      const field = schema.find((candidate) => name(candidate) === column)!
      // A scalar column that is the key of a relation: the relation line names it in fields: [...] and says what delete does.
      const relation = schema.find((candidate) => candidate.model === field.model && candidate.line.includes(`fields: [${field.field}]`))
      if (!relation) continue
      assert.match(relation.line, new RegExp(`onDelete: ${wanted}`), `${column}: schema says something other than ${wanted}`)
    }
  }
})
