import assert from 'node:assert/strict'
import test from 'node:test'
import { algebraEquivalent, checkPracticeAnswer, missNote, splitChoices } from './practice-check'

const numeric = { answerType: 'numeric' as const, correctAnswer: '4', acceptableAnswers: ['four'] }
const text = { answerType: 'text' as const, correctAnswer: 'Breadth-first search', acceptableAnswers: ['BFS'] }

test('trims and ignores case', () => {
  assert.equal(checkPracticeAnswer(text, '  breadth-first SEARCH '), true)
  assert.equal(checkPracticeAnswer(text, 'bfs'), true)
  assert.equal(checkPracticeAnswer(text, 'dfs'), false)
  assert.equal(checkPracticeAnswer(text, '   '), false)
})

test('numeric steps allow 1% relative tolerance', () => {
  const step = { answerType: 'numeric' as const, correctAnswer: '1250', acceptableAnswers: [] }
  assert.equal(checkPracticeAnswer(step, '1250'), true)
  assert.equal(checkPracticeAnswer(step, '1,260'), true)
  assert.equal(checkPracticeAnswer(step, '1263'), false)
  assert.equal(checkPracticeAnswer(numeric, '4.03'), true)
  assert.equal(checkPracticeAnswer(numeric, '4.1'), false)
  // units and fractions are read off a numeric answer
  assert.equal(checkPracticeAnswer({ ...numeric, correctAnswer: '9.8' }, '9.8 m/s^2'), true)
  assert.equal(checkPracticeAnswer({ ...numeric, correctAnswer: '0.75' }, '3/4'), true)
})

test('multiple choice matches by option letter', () => {
  const step = { answerType: 'multiple_choice' as const, correctAnswer: 'B', acceptableAnswers: [] }
  assert.equal(checkPracticeAnswer(step, 'b'), true)
  assert.equal(checkPracticeAnswer(step, 'B. O(V + E)'), true)
  assert.equal(checkPracticeAnswer(step, 'C'), false)
})

test('splitChoices pulls option lines out of the question', () => {
  const parsed = splitChoices('Which is faster?\nA) O(n)\nB) O(n log n)\nC) O(n^2)')
  assert.equal(parsed?.stem, 'Which is faster?')
  assert.deepEqual(parsed?.options.map((option) => option.id), ['A', 'B', 'C'])
  assert.equal(splitChoices('What is 2 + 2?'), null)
})

// ---- numeric equivalence ----------------------------------------------------------------------

const tex = String.raw
const numericKey = (correctAnswer: string, acceptableAnswers: string[] = [], tolerance?: number | null) => ({
  answerType: 'numeric' as const,
  correctAnswer,
  acceptableAnswers,
  tolerance,
})
const textKey = (correctAnswer: string, acceptableAnswers: string[] = []) => ({
  answerType: 'text' as const,
  correctAnswer,
  acceptableAnswers,
})

test('a fraction key accepts equivalent fractions, decimals and percents', () => {
  const step = numericKey('1/17')
  const accepted = ['3/51', '0.0588', '0.05882', '5.88%', '1/17', '( 3 ) / ( 51 )', tex`\frac{3}{51}`, tex`\dfrac{1}{17}`, tex`$\frac{1}{17}$`]
  for (const input of accepted) assert.equal(checkPracticeAnswer(step, input), true, input)
  assert.equal(checkPracticeAnswer(step, '1/18'), false)
  assert.equal(checkPracticeAnswer(step, '0.06'), false)
  assert.equal(checkPracticeAnswer(step, '6%'), false)
})

test('thousands separators, scientific notation, mixed numbers and unicode minus', () => {
  assert.equal(checkPracticeAnswer(numericKey('1,250'), '1250'), true)
  assert.equal(checkPracticeAnswer(numericKey('1250'), '1,250'), true)
  assert.equal(checkPracticeAnswer(numericKey('12,345,678'), '12345678'), true)
  assert.equal(checkPracticeAnswer(numericKey('-3.5'), '−3.5'), true)
  assert.equal(checkPracticeAnswer(numericKey('−3.5'), '-3.5'), true)
  assert.equal(checkPracticeAnswer(numericKey('1.5'), '1 1/2'), true)
  assert.equal(checkPracticeAnswer(numericKey('1.5'), '3/2'), true)
  assert.equal(checkPracticeAnswer(numericKey('6.02e23'), tex`6.02 \times 10^{23}`), true)
  assert.equal(checkPracticeAnswer(numericKey('6.02e23'), '6.02*10^23'), true)
  assert.equal(checkPracticeAnswer(numericKey('0.001'), '1e-3'), true)
  assert.equal(checkPracticeAnswer(numericKey('-0.5'), tex`\frac{-1}{2}`), true)
  assert.equal(checkPracticeAnswer(numericKey('-0.5'), '-(1)/(2)'), true)
})

test('an absolute tolerance on the step overrides the 1% rule', () => {
  const step = numericKey('0.0588', [], 0.001)
  assert.equal(checkPracticeAnswer(step, '0.0595'), true)
  assert.equal(checkPracticeAnswer(step, '0.062'), false)
  assert.equal(checkPracticeAnswer(numericKey('4', [], 0), '4.03'), false)
  assert.equal(checkPracticeAnswer(numericKey('4', [], 0), '4'), true)
  assert.equal(checkPracticeAnswer(numericKey('4', [], 0.05), '4.03'), true)
  // a wide absolute tolerance accepts what 1% would reject; null or NaN fall back to 1%
  assert.equal(checkPracticeAnswer(numericKey('100', [], 5), '104'), true)
  assert.equal(checkPracticeAnswer(numericKey('100', [], null), '104'), false)
  assert.equal(checkPracticeAnswer(numericKey('100', [], Number.NaN), '100.5'), true)
  assert.equal(checkPracticeAnswer(numericKey('100', [], Number.NaN), '102'), false)
})

// ---- text normalisation -----------------------------------------------------------------------

test('light LaTeX and whitespace are normalised on both sides', () => {

  assert.equal(checkPracticeAnswer(textKey(tex`\mathrm{O}(n \log n)`), 'O(n log n)'), true)
  assert.equal(checkPracticeAnswer(textKey('(1, 2)'), '(1,2)'), true)
  assert.equal(checkPracticeAnswer(textKey('Big-O notation.'), 'big-o NOTATION'), true)
  assert.equal(checkPracticeAnswer(textKey('bfs'), 'sfb'), false)
  assert.equal(checkPracticeAnswer(textKey('bfs'), 'bf'), false)
})

// ---- algebra ----------------------------------------------------------------------------------

test('equivalent algebraic forms are accepted', () => {
  const same: [string, string][] = [
    ['p(1-p)^k', '(1-p)^k p'],
    ['2x+2', '2(x+1)'],
    ['sqrt(x)', 'x^(1/2)'],
    ['2^10', '1024'],
    ['sin^2(x)+cos^2(x)', '1+x-x'],
  ]
  for (const [a, b] of same) {
    assert.equal(checkPracticeAnswer(textKey(a), b), true, `${a} vs ${b}`)
    assert.equal(checkPracticeAnswer(textKey(b), a), true, `${b} vs ${a}`)
  }
})

test('different formulas are rejected', () => {
  const different: [string, string][] = [
    ['(1-p)^k p', 'p(1-p)^(k+1)'],
    ['x^2+1', '(x+1)^2'],
    ['x^1/2', 'x^(1/2)'],
    ['2x+2', '2x+1'],
    ['2^3^2', '(2^3)^2'],
  ]
  for (const [a, b] of different) {
    assert.equal(checkPracticeAnswer(textKey(a), b), false, `${a} vs ${b}`)
    assert.equal(checkPracticeAnswer(numericKey(a), b), false, `${a} vs ${b} (numeric step)`)
  }
})

test('the evaluator never executes code', () => {
  const inputs = [
    'process.exit(1)',
    'constructor.constructor("return 1")()',
    '(()=>1)()',
    'this["constructor"]',
    'globalThis',
    'require("fs")',
    '__proto__',
    'a.b(1)',
  ]
  for (const input of inputs) {
    assert.equal(checkPracticeAnswer(textKey('1'), input), false, input)
    assert.equal(checkPracticeAnswer(numericKey('1'), input), false, input)
    assert.equal(checkPracticeAnswer(textKey(input), '1'), false, input)
    assert.equal(algebraEquivalent(input, input), false, input)
  }
})

// ---- lists ------------------------------------------------------------------------------------

test('a key listing one number in several forms accepts any of them', () => {
  const step = numericKey('0.0588, 1/17, 5.88%')
  for (const input of ['0.0588', '1/17', '5.88%', '3/51']) {
    assert.equal(checkPracticeAnswer(step, input), true, input)
  }
  assert.equal(checkPracticeAnswer(step, '0.5'), false)
  const semicolons = numericKey('0.25; 1/4; 25%')
  assert.equal(checkPracticeAnswer(semicolons, '1/4'), true)
  assert.equal(checkPracticeAnswer(semicolons, '1/5'), false)
})

test('a key with different numbers is a set answer in any order', () => {
  const step = numericKey('2, 3')
  assert.equal(checkPracticeAnswer(step, '2, 3'), true)
  assert.equal(checkPracticeAnswer(step, '3, 2'), true)
  assert.equal(checkPracticeAnswer(step, '3,2'), true)
  assert.equal(checkPracticeAnswer(step, '2 and 3'), true)
  assert.equal(checkPracticeAnswer(step, '3; 2'), true)
  assert.equal(checkPracticeAnswer(step, '2'), false)
  assert.equal(checkPracticeAnswer(step, '3'), false)
  assert.equal(checkPracticeAnswer(step, '2, 2'), false)
  assert.equal(checkPracticeAnswer(step, '2, 3, 4'), false)
  assert.equal(checkPracticeAnswer(step, '2, 4'), false)
  const textStep = textKey('2, 3')
  assert.equal(checkPracticeAnswer(textStep, '3, 2'), true)
  assert.equal(checkPracticeAnswer(textStep, '2'), false)
  assert.equal(checkPracticeAnswer(textKey('1/2, 1/3'), '0.333, 0.5'), false) // tight on text steps
  assert.equal(checkPracticeAnswer(textKey('1/2, 1/3'), '2/4, 1/3'), true)
  assert.equal(checkPracticeAnswer(numericKey('1/2, 1/3'), '0.333, 0.5'), true)
  // non-numeric pieces are alternatives, not a set
  assert.equal(checkPracticeAnswer(numericKey('x = 2, x = 3'), 'x = 3'), true)
})

test('a miss says only that the answer is not a number, never anything about its size', () => {
  const step = { answerType: 'numeric' as const, correctAnswer: '12', acceptableAnswers: [] }
  assert.match(missNote(step, 'twelve-ish') ?? '', /number/)
  // Any number, however close or far (a power of ten, a sign, a slipped digit), gets no note: it would confirm the digits.
  for (const wrong of ['1200', '0.12', '1.2 m', '13', '-12', '12.0000001']) assert.equal(missNote(step, wrong), null, wrong)
  assert.equal(missNote({ ...step, correctAnswer: '0' }, '10'), null)
  // Never on a step whose key is not a number, nor on text or multiple choice, nor on a blank.
  assert.equal(missNote({ ...step, correctAnswer: 'a queue' }, 'stack'), null)
  assert.equal(missNote(text, 'dfs'), null)
  assert.equal(missNote({ answerType: 'multiple_choice' as const, correctAnswer: 'B', acceptableAnswers: [] }, 'C'), null)
  assert.equal(missNote(step, '  '), null)
})
