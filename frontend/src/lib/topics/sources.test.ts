import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePracticeProblems, parseSolvedExamples } from '@/features/topic/content'
import { formatPages, fromLabel, fromLine, mergeSources, parseSources, sourceText, type SourceRef } from './sources'

const ref = (filename: string, pageStart: number | null, pageEnd: number | null, materialId: string | null = 'm1'): SourceRef => ({
  materialId,
  filename,
  pageStart,
  pageEnd,
})

test('mergeSources joins touching page ranges of one file and keeps other files apart', () => {
  const merged = mergeSources([ref('a.pdf', 9, 10), ref('a.pdf', 3, 5), ref('b.pdf', 1, 1, 'm2'), ref('a.pdf', 6, 6), ref('a.pdf', 4, 4)])
  assert.deepEqual(
    merged.map((source) => [source.filename, source.pageStart, source.pageEnd]),
    [
      ['a.pdf', 3, 6],
      ['a.pdf', 9, 10],
      ['b.pdf', 1, 1],
    ]
  )
})

test('mergeSources keeps a file without pages once and does not mutate its input', () => {
  const input = [ref('a.pdf', 3, 3), ref('a.pdf', 4, 4), ref('deck.pptx', null, null, 'm3'), ref('deck.pptx', null, null, 'm3')]
  const merged = mergeSources(input)
  assert.deepEqual(merged.map(sourceText), ['a.pdf, pp. 3-4', 'deck.pptx'])
  assert.equal(input[0].pageEnd, 3)
})

test('parseSources reads the stored snake_case shape and drops entries without a file', () => {
  assert.deepEqual(
    parseSources([
      { material_id: 'm1', filename: 'a.pdf', page_start: 3, page_end: 5 },
      { material_id: 'm2', filename: 'b.docx', page_start: null, page_end: null },
      { filename: 'c.pdf', page_start: 2 },
      { filename: '' },
      'junk',
    ]),
    [
      { materialId: 'm1', filename: 'a.pdf', pageStart: 3, pageEnd: 5 },
      { materialId: 'm2', filename: 'b.docx', pageStart: null, pageEnd: null },
      { materialId: null, filename: 'c.pdf', pageStart: 2, pageEnd: 2 },
    ]
  )
  assert.deepEqual(parseSources(undefined), [])
})

test('worked examples and practice problems carry their sources; older content has none', () => {
  const sources = [{ material_id: 'm1', filename: 'a.pdf', page_start: 3, page_end: 3 }]
  const solved = parseSolvedExamples([{ title: 't', problem_statement: 'p', solution_steps: [], sources }], 'now')
  assert.equal(solved?.items[0].sources[0].filename, 'a.pdf')
  const practice = parsePracticeProblems(
    [{ title: 't', steps: [{ question: 'q', correct_answer: '1', answer_type: 'numeric' }], sources }],
    'now'
  )
  assert.equal(practice?.items[0].sources[0].pageStart, 3)
  const old = parseSolvedExamples([{ title: 't', problem_statement: 'p' }], 'now')
  assert.deepEqual(old?.items[0].sources, [])
})

test('practice steps carry their options and tolerance', () => {
  const practice = parsePracticeProblems(
    [
      {
        title: 't',
        steps: [
          {
            question: 'Pick',
            answer_type: 'multiple_choice',
            correct_answer: 'B',
            options: [
              { id: 'A', text: 'first' },
              { id: 'B', text: 'second' },
              { id: '', text: 'broken' },
            ],
          },
          { question: 'How many?', answer_type: 'numeric', correct_answer: '0.0588', tolerance: 0.005 },
          { question: 'Name it', answer_type: 'text', correct_answer: 'x', tolerance: -1 },
        ],
      },
    ],
    'now'
  )
  const [pick, count, name] = practice!.items[0].steps
  assert.deepEqual(pick.options, [
    { id: 'A', text: 'first' },
    { id: 'B', text: 'second' },
  ])
  assert.equal(pick.tolerance, null)
  assert.equal(count.tolerance, 0.005)
  assert.deepEqual(count.options, [])
  assert.equal(name.tolerance, null)
})
