import assert from 'node:assert/strict'
import test from 'node:test'
import {
  algebraEquivalent,
  checkPracticeAnswer,
  missNote,
  normalizeAnswer,
  numberCandidates,
  parseNumber,
  splitChoices,
  withinTolerance,
} from './practice-check'

const numeric = { answerType: 'numeric' as const, correctAnswer: '4', acceptableAnswers: ['four'] }
const text = { answerType: 'text' as const, correctAnswer: 'Breadth-first search', acceptableAnswers: ['BFS'] }

test('trims and ignores case', () => {
  assert.equal(checkPracticeAnswer(text, '  breadth-first SEARCH '), true)
  assert.equal(checkPracticeAnswer(text, 'bfs'), true)
  assert.equal(checkPracticeAnswer(text, 'dfs'), false)
  assert.equal(checkPracticeAnswer(text, '   '), false)
})

test('accepts an acceptable answer even for a numeric step', () => {
  assert.equal(checkPracticeAnswer(numeric, 'Four'), true)
})

test('numeric steps allow 1% relative tolerance', () => {
  const step = { answerType: 'numeric' as const, correctAnswer: '1250', acceptableAnswers: [] }
  assert.equal(checkPracticeAnswer(step, '1250'), true)
  assert.equal(checkPracticeAnswer(step, '1,260'), true)
  assert.equal(checkPracticeAnswer(step, '1263'), false)
  assert.equal(checkPracticeAnswer(numeric, '4.03'), true)
  assert.equal(checkPracticeAnswer(numeric, '4.1'), false)
})

test('numeric answers tolerate units, fractions and zero', () => {
  assert.equal(checkPracticeAnswer({ ...numeric, correctAnswer: '9.8' }, '9.8 m/s^2'), true)
  assert.equal(checkPracticeAnswer({ ...numeric, correctAnswer: '0.75' }, '3/4'), true)
  assert.equal(checkPracticeAnswer({ ...numeric, correctAnswer: '0' }, '0'), true)
  assert.equal(checkPracticeAnswer({ ...numeric, correctAnswer: '0' }, '0.5'), false)
  assert.equal(checkPracticeAnswer(numeric, 'abc'), false)
})

test('tolerance only applies to numeric steps', () => {
  assert.equal(checkPracticeAnswer({ ...text, correctAnswer: '4', acceptableAnswers: [] }, '4.03'), false)
})

test('multiple choice matches by option letter', () => {
  const step = { answerType: 'multiple_choice' as const, correctAnswer: 'B', acceptableAnswers: [] }
  assert.equal(checkPracticeAnswer(step, 'b'), true)
  assert.equal(checkPracticeAnswer(step, 'B)'), true)
  assert.equal(checkPracticeAnswer(step, 'B. O(V + E)'), true)
  assert.equal(checkPracticeAnswer(step, 'C'), false)
  const withText = { answerType: 'multiple_choice' as const, correctAnswer: 'B) O(V + E)', acceptableAnswers: [] }
  assert.equal(checkPracticeAnswer(withText, 'B'), true)
  assert.equal(checkPracticeAnswer(withText, 'o(v + e)'), false)
})

test('parseNumber and withinTolerance', () => {
  assert.equal(parseNumber('6.02e23'), 6.02e23)
  assert.equal(parseNumber('-3.5 cm'), -3.5)
  assert.equal(parseNumber('x'), null)
  assert.equal(parseNumber('1/0'), null)
  assert.equal(withinTolerance(101, 100), true)
  assert.equal(withinTolerance(102, 100), false)
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

test('a decimal key accepts fractions, percents and a bare leading dot', () => {
  const step = numericKey('0.25')
  for (const input of ['1/4', '25%', '.25', '0.250', '25 %', '2.5e-1', tex`\frac{1}{4}`]) {
    assert.equal(checkPracticeAnswer(step, input), true, input)
  }
  assert.equal(checkPracticeAnswer(step, '1/3'), false)
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

test('text steps compare numbers tightly but still across forms', () => {
  assert.equal(checkPracticeAnswer(textKey('1/17'), '3/51'), true)
  assert.equal(checkPracticeAnswer(textKey('0.25'), '25%'), true)
  assert.equal(checkPracticeAnswer(textKey('1,250'), '1250'), true)
  assert.equal(checkPracticeAnswer(textKey('0.0588'), '0.0589'), false)
  assert.equal(checkPracticeAnswer(textKey('1/17'), '0.0588'), false)
  // units are only ignored on numeric steps
  assert.equal(checkPracticeAnswer(textKey('9.8'), '9.8 m/s^2'), false)
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

test('unit-bearing numeric answers still work', () => {
  assert.equal(checkPracticeAnswer(numericKey('9.8'), '9.8 m/s^2'), true)
  assert.equal(checkPracticeAnswer(numericKey('9.8'), '9.8 m/s²'), true)
  assert.equal(checkPracticeAnswer(numericKey('9.8 m/s^2'), '9.8'), true)
  assert.equal(checkPracticeAnswer(numericKey('0.75'), '3/4 cups'), true)
  assert.equal(checkPracticeAnswer(numericKey('12'), '12cm'), true)
  assert.equal(checkPracticeAnswer(numericKey('9.8'), '9.9 m/s^2'), false)
  // a number followed by more math is not "a number with a unit"
  assert.equal(checkPracticeAnswer(numericKey('4'), '4x+1'), false)
  assert.equal(checkPracticeAnswer(numericKey('4'), '4 or 5'), false)
})

test('number candidates and parseNumber cover the extended forms', () => {
  assert.deepEqual(numberCandidates('5.88%', false), [0.0588, 5.88])
  assert.equal(numberCandidates('1,25', false), null)
  assert.equal(numberCandidates('2, 3', false), null)
  assert.equal(numberCandidates('1/0', false), null)
  assert.equal(numberCandidates('3 cm', false), null)
  assert.deepEqual(numberCandidates('3 cm', true), [3])
  assert.equal(parseNumber('3/4 cups'), 0.75)
  assert.equal(parseNumber('1 1/2'), 1.5)
  assert.equal(parseNumber('(3)/(4)'), 0.75)
})

// ---- text normalisation -----------------------------------------------------------------------

test('light LaTeX and whitespace are normalised on both sides', () => {
  assert.equal(normalizeAnswer(tex`$\frac{a+1}{b}$`), '(a+1)/(b)')
  assert.equal(normalizeAnswer(tex`\sqrt{x}`), 'sqrt(x)')
  assert.equal(normalizeAnswer(tex`\text{Hello}  World.`), 'hello world')
  assert.equal(normalizeAnswer(tex`x^{2}\,\cdot\,y`), 'x^(2)*y')
  assert.equal(normalizeAnswer(tex`3 \times 4`), '3 * 4')
  assert.equal(normalizeAnswer(tex`\left( x \right)`), '( x )')
  assert.equal(normalizeAnswer(tex`50\%`), '50%')
  assert.equal(normalizeAnswer(tex`2\pi`), '2pi')
  assert.equal(normalizeAnswer('−3 × 2 ÷ x² + y³'), '-3 * 2 / x^2 + y^3')
  assert.equal(normalizeAnswer(tex`\frac{\sqrt{2}}{2}`), '(sqrt(2))/(2)')

  assert.equal(checkPracticeAnswer(textKey(tex`\mathrm{O}(n \log n)`), 'O(n log n)'), true)
  assert.equal(checkPracticeAnswer(textKey('(1, 2)'), '(1,2)'), true)
  assert.equal(checkPracticeAnswer(textKey('Big-O notation.'), 'big-o NOTATION'), true)
  assert.equal(checkPracticeAnswer(textKey(tex`2\pi r`), '2PI R'), true)
  assert.equal(checkPracticeAnswer(textKey('bfs'), 'sfb'), false)
  assert.equal(checkPracticeAnswer(textKey('bfs'), 'bf'), false)
})

// ---- algebra ----------------------------------------------------------------------------------

test('equivalent algebraic forms are accepted', () => {
  const same: [string, string][] = [
    ['p(1-p)^k', '(1-p)^k p'],
    ['p(1-p)^k', 'p*(1-p)^k'],
    ['p(1-p)^k', 'p (1 - p)^k'],
    ['p(1-p)^k', tex`\left(1-p\right)^{k} p`],
    ['2x+2', '2(x+1)'],
    ['x^2-1', '(x-1)(x+1)'],
    ['e^{-x}', 'exp(-x)'],
    ['1/(1-p)', '(1-p)^(-1)'],
    ['sqrt(x)', 'x^(1/2)'],
    [tex`\sqrt{x}`, tex`x^{1/2}`],
    ['-x^2', '-(x^2)'],
    ['n log(n)', 'n*ln(n)'],
    ['xy+1', 'y*x+1'],
    ['x_1 + x_{2}', 'x_2+x_1'],
    [tex`\lambda e^{-\lambda x}`, 'lambda*exp(-lambda*x)'],
    ['2^10', '1024'],
    ['sin^2(x)+cos^2(x)', '1+x-x'],
    ['log10(x)', 'ln(x)/ln(10)'],
    ['3(x+1)', '3x+3'],
    ['(a)(b)', 'a*b'],
    ['2pi r', '2*pi*r'],
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
    ['x^2-1', '(x-1)^2'],
    ['-x^2', '(-x)^2'],
    ['x^1/2', 'x^(1/2)'],
    ['1/2x', '1/(2x)'],
    ['2x+2', '2x+1'],
    ['p(1-p)^k', 'q(1-p)^k'],
    ['x+y', 'x'],
    ['e^x', 'exp(2x)'],
    ['2^3^2', '(2^3)^2'],
    ['sqrt(x)', 'x^2'],
  ]
  for (const [a, b] of different) {
    assert.equal(checkPracticeAnswer(textKey(a), b), false, `${a} vs ${b}`)
    assert.equal(checkPracticeAnswer(numericKey(a), b), false, `${a} vs ${b} (numeric step)`)
  }
})

test('algebraEquivalent is case-sensitive, needs matching variables and a formula-like input', () => {
  assert.equal(algebraEquivalent('p(1-p)^k', '(1-p)^k p'), true)
  assert.equal(algebraEquivalent('P(1-p)^k', 'p(1-p)^k'), false)
  assert.equal(algebraEquivalent('x+1', 'x+1+0*y'), false)
  assert.equal(algebraEquivalent('x +', 'x'), false)
  assert.equal(algebraEquivalent('2 3', '6'), false)
  assert.equal(algebraEquivalent('sqrt(-x)', 'sqrt(-x)'), false) // no usable points in the domain
  assert.equal(algebraEquivalent('x=1', 'x=1'), false)
  assert.equal(algebraEquivalent(`${'x'.repeat(81)}+1`, 'x+1'), false)
  // plain words: no operator or digit means the algebra path is never attempted
  assert.equal(algebraEquivalent('bfs', 'sfb'), false)
  assert.equal(algebraEquivalent('ab', 'ba'), false)
})

test('numeric steps fall back to algebra only when the input is not a number', () => {
  assert.equal(checkPracticeAnswer(numericKey('2^10'), '1024'), false) // input is a number, key is not
  assert.equal(checkPracticeAnswer(numericKey('1024'), '2^10'), true)
  assert.equal(checkPracticeAnswer(numericKey('1024'), '2^9'), false)
  assert.equal(checkPracticeAnswer(numericKey('sqrt(2)/2'), '1/sqrt(2)'), true)
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

test('a key listing text pieces treats them as alternatives', () => {
  const step = textKey('BFS, breadth-first search')
  assert.equal(checkPracticeAnswer(step, 'bfs'), true)
  assert.equal(checkPracticeAnswer(step, 'Breadth-First Search'), true)
  assert.equal(checkPracticeAnswer(step, 'BFS, breadth-first search'), true)
  assert.equal(checkPracticeAnswer(step, 'dfs'), false)
  const orKey = textKey('a queue or FIFO | first in first out')
  assert.equal(checkPracticeAnswer(orKey, 'a queue'), true)
  assert.equal(checkPracticeAnswer(orKey, 'fifo'), true)
  assert.equal(checkPracticeAnswer(orKey, 'first in first out'), true)
  assert.equal(checkPracticeAnswer(orKey, 'a stack'), false)
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

test('list parsing leaves thousands groups and bracketed pairs alone', () => {
  assert.equal(checkPracticeAnswer(numericKey('1,250'), '1250'), true)
  assert.equal(checkPracticeAnswer(numericKey('1,250'), '1'), false)
  assert.equal(checkPracticeAnswer(numericKey('1,250'), '250'), false)
  assert.equal(checkPracticeAnswer(numericKey('12,345,678'), '12345678'), true)
  assert.equal(checkPracticeAnswer(numericKey('12,345,678'), '345'), false)
  assert.equal(checkPracticeAnswer(numericKey('1,250, 3'), '3, 1250'), true)
  assert.equal(checkPracticeAnswer(textKey('(1, 2)'), '(1, 2)'), true)
  assert.equal(checkPracticeAnswer(textKey('(1, 2)'), '1'), false)
  assert.equal(checkPracticeAnswer(textKey('(1, 2)'), '2'), false)
  assert.equal(checkPracticeAnswer(textKey('f(a, b), g(c)'), 'g(c)'), true)
  assert.equal(checkPracticeAnswer(textKey('f(a, b), g(c)'), 'a'), false)
  assert.equal(checkPracticeAnswer(textKey('[1, 2], [3, 4]'), '[3, 4]'), true)
  assert.equal(checkPracticeAnswer(textKey('rock and roll'), 'rock'), false)
})

test('multiple choice is untouched by the new matching', () => {
  const step = { answerType: 'multiple_choice' as const, correctAnswer: '1/2', acceptableAnswers: [] }
  assert.equal(checkPracticeAnswer(step, '0.5'), false)
  assert.equal(checkPracticeAnswer(step, '1/2'), true)
  const letters = { answerType: 'multiple_choice' as const, correctAnswer: 'B', acceptableAnswers: [] }
  assert.equal(checkPracticeAnswer(letters, '(b)'), true)
  assert.equal(checkPracticeAnswer(letters, 'a'), false)
  assert.equal(checkPracticeAnswer({ ...letters, correctAnswer: 'B, C' }, 'c'), false)
})

test('a hyphen between words is the same as a space', () => {
  assert.equal(checkPracticeAnswer(text, 'breadth first search'), true)
  assert.equal(checkPracticeAnswer({ ...text, correctAnswer: 'breadth first search' }, 'Breadth-first search'), true)
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
