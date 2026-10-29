import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { GENERATION, MODEL_CHOICE, RETRIEVAL } from './evals'

// The page quotes numbers from the committed result files. These tests read the files, so the page cannot drift.
const root = path.resolve(process.cwd(), '..', 'evals', 'results')
const read = (name: string) => readFileSync(path.join(root, name), 'utf8')

/** The cells of the table row that starts with `label`, first match in the file. */
function row(text: string, label: string): string[] {
  const line = text.split('\n').find((l) => l.startsWith('|') && l.split('|')[1].trim().startsWith(label))
  assert.ok(line, `no table row starting with "${label}"`)
  return line.split('|').slice(1, -1).map((cell) => cell.trim())
}

test('retrieval numbers match the rrf and baseline result files', () => {
  const rrf = read('2026-10-20-rrf.md')
  const baseline = read('2026-10-20-baseline.md')
  // Overall columns: recall@24, precision@24, MRR, nDCG@24, hit@5, same-doc share
  const pick = (cells: string[]) => [cells[1], cells[3], cells[4], cells[5]]
  const [app, vector] = RETRIEVAL.rows
  assert.deepEqual(app.values, pick(row(rrf, 'app: hybrid_search_chunks')))
  assert.deepEqual(vector.values, pick(row(rrf, 'reference: vector cosine, query = name + description + keywords')))
  assert.deepEqual(RETRIEVAL.rows[2].values, pick(row(baseline, 'app: hybrid_search_chunks')))
  assert.match(rrf, new RegExp(`- Topics: ${RETRIEVAL.topics}, chunks: ${RETRIEVAL.chunks} `))
  assert.match(rrf, new RegExp(`- Date: ${RETRIEVAL.date}`))
  assert.match(rrf, new RegExp(`K = ${RETRIEVAL.k} `))
})

test('generation numbers match the structure result file', () => {
  const text = read('2026-10-21-structure.md')
  assert.match(text, new RegExp(`- Date: ${GENERATION.date}`))
  assert.match(text, /mit-18\.05 4, mit-6\.006 4/)
  assert.match(text, new RegExp(`Models: ${GENERATION.model}`))
  assert.match(text, new RegExp(`Judge: ${GENERATION.model}`))
  assert.match(text, new RegExp(`Judged ${GENERATION.judgedItems} \\(topic, type\\) pairs`))
  assert.match(text, new RegExp(`total \\${GENERATION.totalSpend}`))

  const judge = row(text, 'opus:medium') // first opus row is the cost table
  assert.equal(judge[1], GENERATION.costPerTopic)
  const scores = text.split('\n').find((l) => l.startsWith('| opus:medium | 4.88'))
  assert.ok(scores)
  const cells = scores.split('|').slice(2, -1).map((c) => c.trim())
  assert.deepEqual(
    GENERATION.judgeScores.map((s) => s.value),
    cells.slice(0, 4)
  )
  assert.equal(String(GENERATION.mathErrors), cells[4])
  assert.equal(String(GENERATION.errors), cells[5])

  const check = (label: string) => row(text, label)[1]
  const [sections, band, dollars, recap, examples, practice, quizzes, restate] = GENERATION.checks
  assert.equal(check('Notes with all expected sections'), sections.value.replace(' of ', '/'))
  // The file reads "0/8 (mean 1749 words)"; the page writes "0 of 8 (mean 1,749 words)".
  assert.equal(check('Notes inside the requested word band'), band.value.replace(' of ', '/').replace('1,749', '1749'))
  assert.equal(check('Plain-text fields with'), dollars.value)
  assert.equal(check('Notes with 5-8 recap bullets'), recap.value.replace(' of ', '/'))
  assert.equal(check('Worked-example sets'), examples.value.replace(' of ', '/'))
  assert.equal(check('Practice sets'), practice.value.replace(' of ', '/'))
  assert.equal(check('Quizzes with the requested'), quizzes.value.replace(' of ', '/'))
  assert.match(text, /4 of 32 numeric questions \(12%\)/)
  assert.equal(restate.value, '12% (4 of 32)')
})

test('model choice numbers match the model decision file', () => {
  const text = read('2026-10-21-model-decision.md')
  const labels = ['Opus, medium', 'Sonnet, medium', 'Haiku, medium']
  MODEL_CHOICE.rows.forEach((r, i) => {
    assert.equal(r.label, labels[i])
    assert.deepEqual(r.values, row(text, labels[i]).slice(1))
  })
})
