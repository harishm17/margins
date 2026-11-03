import type { PracticeStep } from './types'

/**
 * Checking a practice answer in the browser. The key is in the page payload by design, so this
 * is a convenience for the student, not a security boundary.
 *
 * An answer is right when it matches the correct answer or any acceptable answer by one of:
 *   1. text, after light LaTeX clean-up and ignoring case and spacing;
 *   2. number, when both sides are whole number expressions ("3/51", "5.88%", "1,250", "1e-3"):
 *      within 1% for numeric steps (or an absolute `tolerance` when the step has one), and within
 *      1e-6 for text steps;
 *   3. algebra, when both sides are small formulas ("p(1-p)^k" and "(1-p)^k p"), compared by
 *      evaluating them at pseudo-random points with a safe parser (never eval);
 *   4. list, when a key such as "2, 3" or "BFS, breadth-first search" holds several pieces.
 * Multiple choice steps only compare option letters.
 */

export const NUMERIC_TOLERANCE = 0.01
/** Relative tolerance for numbers compared inside a text step (equal up to float noise). */
export const TEXT_TOLERANCE = 1e-6

/** The step fields the checker reads; `tolerance` is an absolute tolerance for numeric steps. */
export type PracticeCheckStep = Pick<PracticeStep, 'answerType' | 'correctAnswer' | 'acceptableAnswers'> & {
  tolerance?: number | null
}

// ---------------------------------------------------------------------------------------------
// Normalising text
// ---------------------------------------------------------------------------------------------

/** Reads a balanced `{...}` group starting at `open`; returns its content and the index after it. */
function readBraces(text: string, open: number): { content: string; end: number } | null {
  if (text[open] !== '{') return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return { content: text.slice(open + 1, i), end: i + 1 }
  }
  return null
}

const skipSpaces = (text: string, index: number): number => {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Rewrites every `\command{..}{..}` match with `build`, innermost-last, until none are left. */
function rewriteCommand(
  text: string,
  pattern: RegExp,
  groups: number,
  build: (parts: string[]) => string
): string {
  let result = text
  for (let guard = 0; guard < 200; guard++) {
    const match = pattern.exec(result)
    if (!match) break
    const parts: string[] = []
    let end = match.index + match[0].length
    for (let g = 0; g < groups; g++) {
      const group = readBraces(result, skipSpaces(result, end))
      if (!group) break
      parts.push(group.content)
      end = group.end
    }
    const replacement = parts.length === groups ? build(parts) : ''
    result = result.slice(0, match.index) + replacement + result.slice(end)
  }
  return result
}

/** Turns `x^{...}` into `x^(...)`. */
function rewriteSuperscripts(text: string): string {
  let result = text
  for (let guard = 0; guard < 200; guard++) {
    const at = result.indexOf('^{')
    if (at < 0) break
    const group = readBraces(result, at + 1)
    if (!group) {
      result = result.slice(0, at + 1) + result.slice(at + 2)
      continue
    }
    result = `${result.slice(0, at)}^(${group.content})${result.slice(group.end)}`
  }
  return result
}

/**
 * Case-preserving clean-up shared by every comparison: strips `$`, converts light LaTeX
 * (`\frac{a}{b}` -> `(a)/(b)`, `\sqrt{x}` -> `sqrt(x)`, `\cdot`, `\text{..}`, `x^{2}` -> `x^(2)`),
 * maps unicode operators, collapses whitespace and drops a trailing period.
 */
function cleanAnswer(value: string): string {
  let text = value
    .replace(/\$/g, '')
    .replace(/[−]/g, '-')
    .replace(/[×·]/g, '*')
    .replace(/÷/g, '/')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/π/g, 'pi')
    .replace(/√/g, 'sqrt')
    .replace(/\\(?:left|right)(?![a-zA-Z])/g, '')
    .replace(/\\(?:cdot|times)(?![a-zA-Z])/g, '*')
    .replace(/\\[,;!:]/g, '')
    .replace(/\\%/g, '%')
  text = rewriteCommand(text, /\\[dt]?frac(?![a-zA-Z])/, 2, ([a, b]) => `(${a})/(${b})`)
  text = rewriteCommand(text, /\\sqrt(?![a-zA-Z])/, 1, ([a]) => `sqrt(${a})`)
  text = rewriteCommand(text, /\\(?:text|textbf|mathrm|mathbf|mathit|operatorname)(?![a-zA-Z])/, 1, ([a]) => a)
  text = rewriteSuperscripts(text)
    .replace(/\\([a-zA-Z]+)/g, '$1') // \pi, \lambda, \sin, ... lose their backslash
    .replace(/[\\{}]/g, '')
  return text.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '').trim()
}

/** The answer as cleaned text, lower-cased (what two text answers are compared on). */
export const normalizeAnswer = (value: string): string => cleanAnswer(value).toLowerCase()

/** Like `normalizeAnswer` but also ignores spaces around punctuation: "(1, 2)" equals "(1,2)". */
const textKey = (base: string): string =>
  base
    .toLowerCase()
    .replace(/(?<=\p{L})-(?=\p{L})/gu, ' ') // "breadth-first" and "breadth first" are the same answer
    .replace(/\s*([^\p{L}\p{N}\s])\s*/gu, '$1')

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

// A plain number ("1,250", "12.5", ".25") with an optional exponent ("1e-3", "6.02*10^23").
const NUMBER_SOURCE = String.raw`(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[-+]?\d+|\s*[*x]\s*10\s*\^\s*(?:[-+]?\d+|\([-+]?\d+\)))?`
const NUMBER_TOKEN = new RegExp(NUMBER_SOURCE, 'y')
const MIXED_NUMBER = /(\d+)\s+(\d+)\s*\/\s*(\d+)/y
const PERCENT = /^\s*%/
// Up to a few unit words such as "cm", "m/s^2", "kg m/s"; never "and"/"or" (those join list items).
const UNIT = /^[a-zµμ°ω][a-z0-9µμ°ω^*/.\-() ]{0,24}$/
const UNIT_JOINERS = /\b(?:and|or)\b/

type Read = { value: number; end: number }

function readNumber(text: string, start: number): Read | null {
  NUMBER_TOKEN.lastIndex = start
  const match = NUMBER_TOKEN.exec(text)
  if (!match) return null
  const token = match[0].replace(/,/g, '')
  const scientific = /^(.*?)\s*[*x]\s*10\s*\^\s*\(?([-+]?\d+)\)?$/.exec(token)
  const value = scientific ? Number(scientific[1]) * 10 ** Number(scientific[2]) : Number(token)
  return Number.isFinite(value) ? { value, end: start + match[0].length } : null
}

/** A number, or a signed number in parentheses: the operands of a fraction. */
function readOperand(text: string, start: number): Read | null {
  if (text[start] !== '(') return readNumber(text, start)
  let i = skipSpaces(text, start + 1)
  let sign = 1
  if (text[i] === '-' || text[i] === '+') {
    if (text[i] === '-') sign = -1
    i = skipSpaces(text, i + 1)
  }
  const number = readNumber(text, i)
  if (!number) return null
  const close = skipSpaces(text, number.end)
  return text[close] === ')' ? { value: sign * number.value, end: close + 1 } : null
}

/** A mixed number ("1 1/2"), a fraction ("3/51", "(3)/(51)") or a plain number. */
function readValue(text: string, start: number): Read | null {
  MIXED_NUMBER.lastIndex = start
  const mixed = MIXED_NUMBER.exec(text)
  if (mixed) {
    const bottom = Number(mixed[3])
    if (bottom === 0) return null
    return { value: Number(mixed[1]) + Number(mixed[2]) / bottom, end: start + mixed[0].length }
  }
  const top = readOperand(text, start)
  if (!top) return null
  const slash = skipSpaces(text, top.end)
  if (text[slash] !== '/') return top
  const bottom = readOperand(text, skipSpaces(text, slash + 1))
  if (!bottom) return top // "3/x": the leftover fails the full-match check below
  return bottom.value === 0 ? null : { value: top.value / bottom.value, end: bottom.end }
}

/** True when the first "(" closes at the very end, as in "(3/4)" but not "(3)/(4)". */
function isWrapped(text: string): boolean {
  if (text[0] !== '(' || text[text.length - 1] !== ')') return false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i === text.length - 1
  }
  return false
}

/**
 * The values a whole answer stands for, or null when it is not purely a number expression.
 * "5.88%" gives two (0.0588 and 5.88) because it may be meant either way. With `allowUnit`
 * a trailing unit such as "9.8 m/s^2" is ignored.
 */
export function numberCandidates(value: string, allowUnit: boolean): number[] | null {
  let text = normalizeAnswer(value)
  if (isWrapped(text)) text = text.slice(1, -1).trim()
  const signMatch = /^[-+]?\s*/.exec(text)
  const sign = signMatch && signMatch[0].trim() === '-' ? -1 : 1
  const start = signMatch ? signMatch[0].length : 0
  const read = readValue(text, start)
  if (!read) return null

  let end = read.end
  let values = [read.value]
  const percent = PERCENT.exec(text.slice(end))
  if (percent) {
    values = [read.value / 100, read.value]
    end += percent[0].length
  }
  const rest = text.slice(end).trim()
  if (rest && !(allowUnit && UNIT.test(rest) && !UNIT_JOINERS.test(rest))) return null
  return values.map((number) => sign * number).filter(Number.isFinite)
}

/** The number a numeric answer stands for: "1,250", "9.8 m/s^2", "6.02e23" and "3/4" all parse. */
export function parseNumber(value: string): number | null {
  const candidates = numberCandidates(value, true)
  return candidates && candidates.length > 0 ? candidates[candidates.length - 1] : null
}

/** Within 1% of the target (or very close to it when the target is zero). */
export function withinTolerance(given: number, target: number): boolean {
  if (target === 0) return Math.abs(given) < 1e-9
  return Math.abs(given - target) <= Math.abs(target) * NUMERIC_TOLERANCE + 1e-12
}

// ---------------------------------------------------------------------------------------------
// Algebra: a tiny expression parser and evaluator (no eval, no Function)
// ---------------------------------------------------------------------------------------------

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'neg'; operand: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { kind: 'fn'; name: string; arg: Node }

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'fn'; name: string }
  | { kind: 'op'; op: string }

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  abs: Math.abs,
}
const GREEK = ['lambda', 'mu', 'sigma', 'theta', 'alpha', 'beta', 'gamma', 'phi', 'rho', 'tau', 'omega', 'delta', 'epsilon']
// Names recognised inside a run of letters, longest first so "exp" wins over "e".
const KNOWN_NAMES = [...Object.keys(FUNCTIONS), ...GREEK, 'pi'].sort((a, b) => b.length - a.length)

class ParseError extends Error {}

/** Splits a run of letters: "xy" -> x, y; "2xsin" -> x, sin; "sigmax" -> sigma, x; "e" and "pi" are constants. */
function wordTokens(word: string, subscript: string): Token[] {
  const tokens: Token[] = []
  for (let i = 0; i < word.length; ) {
    const known = KNOWN_NAMES.find((name) => word.startsWith(name, i))
    const name = known ?? word[i]
    i += name.length
    const last = i === word.length
    if (name in FUNCTIONS) tokens.push({ kind: 'fn', name })
    else if (name === 'pi') tokens.push({ kind: 'num', value: Math.PI })
    else if (name === 'e') tokens.push({ kind: 'num', value: Math.E })
    else tokens.push({ kind: 'var', name: last ? name + subscript : name })
  }
  return tokens
}

const NUMBER_LITERAL = /(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/y
const WORD = /[A-Za-z]+/y
const SUBSCRIPT = /_[A-Za-z0-9]+/y
const LOG_BASE = /_?(10|2)(?![\d.])/y

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let afterLiteral: boolean = false // "2 3" is not a product, but "2pi" and "2e" are
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const wasLiteral: boolean = afterLiteral
    afterLiteral = false
    if (/\s/.test(ch)) {
      afterLiteral = wasLiteral
      i++
    } else if (/[\d.]/.test(ch)) {
      NUMBER_LITERAL.lastIndex = i
      const match = NUMBER_LITERAL.exec(text)
      if (!match || wasLiteral) throw new ParseError()
      tokens.push({ kind: 'num', value: Number(match[0]) })
      afterLiteral = true
      i += match[0].length
    } else if (/[A-Za-z]/.test(ch)) {
      WORD.lastIndex = i
      const word = (WORD.exec(text) as RegExpExecArray)[0]
      i += word.length
      LOG_BASE.lastIndex = i
      const base = word.endsWith('log') ? LOG_BASE.exec(text) : null
      if (base) {
        // log2 / log10 / log_2: the base belongs to the function name
        tokens.push(...wordTokens(word.slice(0, -3), ''), { kind: 'fn', name: `log${base[1]}` })
        i += base[0].length
        continue
      }
      SUBSCRIPT.lastIndex = i
      const sub = SUBSCRIPT.exec(text)
      if (sub) i += sub[0].length
      tokens.push(...wordTokens(word, sub ? sub[0] : ''))
    } else if ('+-*/^()'.includes(ch)) {
      tokens.push({ kind: 'op', op: ch })
      i++
    } else {
      throw new ParseError()
    }
  }
  return tokens
}

/**
 * Recursive descent: expr = term (+|- term)*; term = unary ((*|/|implicit) unary)*;
 * unary = -unary | power; power = atom (^ exponent)?  (so -x^2 is -(x^2) and ^ is right-associative).
 */
class Parser {
  private pos = 0
  readonly variables = new Set<string>()

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.expr()
    if (this.pos < this.tokens.length) throw new ParseError()
    return node
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private isOp(op: string): boolean {
    const token = this.peek()
    return token?.kind === 'op' && token.op === op
  }

  private expect(op: string): void {
    if (!this.isOp(op)) throw new ParseError()
    this.pos++
  }

  private startsFactor(): boolean {
    const token = this.peek()
    if (!token) return false
    return token.kind !== 'op' || token.op === '('
  }

  private expr(): Node {
    let left = this.term()
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.pos++] as { op: '+' | '-' }).op
      left = { kind: 'bin', op, left, right: this.term() }
    }
    return left
  }

  private term(): Node {
    let left = this.unary()
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = (this.tokens[this.pos++] as { op: '*' | '/' }).op
        left = { kind: 'bin', op, left, right: this.unary() }
      } else if (this.startsFactor()) {
        left = { kind: 'bin', op: '*', left, right: this.power() } // implicit multiplication
      } else {
        return left
      }
    }
  }

  private unary(): Node {
    if (this.isOp('-')) {
      this.pos++
      return { kind: 'neg', operand: this.unary() }
    }
    if (this.isOp('+')) {
      this.pos++
      return this.unary()
    }
    return this.power()
  }

  private power(): Node {
    const base = this.atom()
    if (!this.isOp('^')) return base
    this.pos++
    return { kind: 'bin', op: '^', left: base, right: this.exponent() }
  }

  private exponent(): Node {
    if (this.isOp('-')) {
      this.pos++
      return { kind: 'neg', operand: this.exponent() }
    }
    if (this.isOp('+')) {
      this.pos++
      return this.exponent()
    }
    return this.power()
  }

  private atom(): Node {
    const token = this.tokens[this.pos++]
    if (!token) throw new ParseError()
    if (token.kind === 'num') return { kind: 'num', value: token.value }
    if (token.kind === 'var') {
      this.variables.add(token.name)
      return { kind: 'var', name: token.name }
    }
    if (token.kind === 'fn') {
      // "sin^2(x)" means sin(x)^2
      let power: Node | null = null
      if (this.isOp('^')) {
        this.pos++
        power = this.exponent()
      }
      const call: Node = { kind: 'fn', name: token.name, arg: this.functionArgument() }
      return power ? { kind: 'bin', op: '^', left: call, right: power } : call
    }
    if (token.op !== '(') throw new ParseError()
    const inner = this.expr()
    this.expect(')')
    return inner
  }

  /** "sqrt(x)" takes the parentheses; "ln x" and "sin x^2" take the next power-level operand. */
  private functionArgument(): Node {
    if (this.isOp('(')) {
      this.pos++
      const inner = this.expr()
      this.expect(')')
      return inner
    }
    if (this.isOp('-')) {
      this.pos++
      return { kind: 'neg', operand: this.functionArgument() }
    }
    return this.power()
  }
}

function evaluate(node: Node, values: Map<string, number>): number {
  switch (node.kind) {
    case 'num':
      return node.value
    case 'var':
      return values.get(node.name) ?? NaN
    case 'neg':
      return -evaluate(node.operand, values)
    case 'fn':
      return FUNCTIONS[node.name](evaluate(node.arg, values))
    case 'bin': {
      const left = evaluate(node.left, values)
      const right = evaluate(node.right, values)
      if (node.op === '+') return left + right
      if (node.op === '-') return left - right
      if (node.op === '*') return left * right
      if (node.op === '/') return left / right
      return left ** right
    }
  }
}

/** Small seeded PRNG so the sample points are the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALGEBRA_CHARS = /^[A-Za-z0-9+\-*/^(). _{}]+$/
const ALGEBRA_HINT = /[-+*/^(\d]/
const ALGEBRA_MAX_LENGTH = 80
const SAMPLE_ATTEMPTS = 64 // random assignments tried, since domain gaps (sqrt, log, x^k) skip some
const SAMPLE_POINTS = 8 // usable points compared per pair
const MIN_USABLE_POINTS = 3
const SAMPLE_TOLERANCE = 1e-7

/** Plain English must never be treated as algebra: it needs an operator or digit and a tame alphabet. */
const looksLikeFormula = (text: string): boolean =>
  text.length <= ALGEBRA_MAX_LENGTH && ALGEBRA_CHARS.test(text) && ALGEBRA_HINT.test(text)

function parseFormula(text: string): { node: Node; variables: Set<string> } | null {
  try {
    const parser = new Parser(tokenize(text))
    return { node: parser.parse(), variables: parser.variables }
  } catch (error) {
    if (error instanceof ParseError) return null
    throw error
  }
}

/**
 * True when two formulas use the same variables and agree (relative 1e-7) at every usable
 * pseudo-random point, with at least three usable points. Variables are case-sensitive.
 * Works on already-cleaned text (see `normalizeAnswer`, but without lower-casing).
 */
export function algebraEquivalent(a: string, b: string): boolean {
  if (!looksLikeFormula(a) || !looksLikeFormula(b)) return false
  const left = parseFormula(a)
  const right = parseFormula(b)
  if (!left || !right) return false
  const names = [...left.variables].sort()
  if (names.length !== right.variables.size || names.some((name) => !right.variables.has(name))) return false

  const random = mulberry32(0x9e3779b9)
  let usable = 0
  for (let attempt = 0; attempt < SAMPLE_ATTEMPTS && usable < SAMPLE_POINTS; attempt++) {
    const values = new Map(names.map((name) => [name, 0.35 + 1.55 * random()] as const))
    const x = evaluate(left.node, values)
    const y = evaluate(right.node, values)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    usable++
    if (Math.abs(x - y) > SAMPLE_TOLERANCE * Math.max(Math.abs(x), Math.abs(y)) + 1e-12) return false
  }
  return usable >= MIN_USABLE_POINTS
}

// ---------------------------------------------------------------------------------------------
// Lists ("2, 3", "BFS, breadth-first search", "0.0588, 1/17, 5.88%")
// ---------------------------------------------------------------------------------------------

const OR_SEPARATOR = /\s+or\s+/iy
const OR_AND_SEPARATOR = /\s+(?:or|and)\s+/iy

/** A comma inside "1,250" or "12,345,678" groups thousands; it is not a separator. */
function isThousandsComma(text: string, index: number): boolean {
  if (!/^\d{3}(?!\d)/.test(text.slice(index + 1))) return false
  let digits = 0
  while (/\d/.test(text[index - 1 - digits] ?? '')) digits++
  return digits >= 1 && digits <= 3 && text[index - 1 - digits] !== '.'
}

/** Splits on `,` `;` `|` and " or " (and optionally " and ") outside parentheses and brackets. */
function splitTopLevel(text: string, withAnd: boolean): string[] {
  const separator = withAnd ? OR_AND_SEPARATOR : OR_SEPARATOR
  const pieces: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    let cut = 0
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      if (ch === ';' || ch === '|' || (ch === ',' && !isThousandsComma(text, i))) {
        cut = 1
      } else if (/\s/.test(ch)) {
        separator.lastIndex = i
        cut = separator.exec(text)?.[0].length ?? 0
      }
    }
    if (cut > 0) {
      pieces.push(text.slice(start, i).trim())
      i += cut
      start = i
    } else {
      i++
    }
  }
  pieces.push(text.slice(start).trim())
  return pieces.filter(Boolean)
}

// ---------------------------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------------------------

type Grader = { numeric: boolean; tolerance: number | null }

/** Whether two numbers agree under the step's rule (absolute tolerance, 1% relative, or tight). */
function valuesClose(given: number, target: number, grader: Grader): boolean {
  if (!grader.numeric) {
    if (target === 0) return Math.abs(given) < 1e-9
    return Math.abs(given - target) <= Math.abs(target) * TEXT_TOLERANCE + 1e-12
  }
  if (grader.tolerance !== null) return Math.abs(given - target) <= grader.tolerance + 1e-12
  return withinTolerance(given, target)
}

const anyClose = (given: number[], target: number[], grader: Grader): boolean =>
  given.some((value) => target.some((wanted) => valuesClose(value, wanted, grader)))

/** One input against one target with no list handling: text, then number, then algebra. */
function matchesPiece(grader: Grader, input: string, target: string): boolean {
  if (textKey(input) === textKey(target)) return true
  const given = numberCandidates(input, grader.numeric)
  const wanted = numberCandidates(target, grader.numeric)
  if (given && wanted) return anyClose(given, wanted, grader)
  // A numeric step whose input parsed as a number is not retried as algebra.
  if (grader.numeric && given) return false
  return algebraEquivalent(cleanAnswer(input), cleanAnswer(target))
}

/** Pieces of a list answer; " and " only splits when every piece is a number ("2 and 3"). */
function splitList(base: string, grader: Grader): string[] {
  const plain = splitTopLevel(base, false)
  if (plain.length > 1) return plain
  const withAnd = splitTopLevel(base, true)
  const allNumbers = withAnd.every((piece) => numberCandidates(piece, grader.numeric) !== null)
  return withAnd.length > 1 && allNumbers ? withAnd : plain
}

/** True when every target value can be paired with a different given value (order ignored). */
function pairsUp(given: number[][], target: number[][], grader: Grader): boolean {
  const used = new Array<boolean>(given.length).fill(false)
  const place = (index: number): boolean => {
    if (index === target.length) return true
    for (let i = 0; i < given.length; i++) {
      if (used[i] || !anyClose(given[i], target[index], grader)) continue
      used[i] = true
      if (place(index + 1)) return true
      used[i] = false
    }
    return false
  }
  return place(0)
}

function matchesTarget(grader: Grader, input: string, target: string): boolean {
  if (matchesPiece(grader, input, target)) return true
  const pieces = splitList(target, grader)
  if (pieces.length < 2) return false

  const values = pieces.map((piece) => numberCandidates(piece, grader.numeric))
  const numbers = values.every((candidates) => candidates !== null)
  if (!numbers) return pieces.some((piece) => matchesPiece(grader, input, piece)) // accepted alternatives

  const all = values as number[][]
  const sameValue = all.every((candidates) =>
    candidates.some((a) => all[0].some((b) => withinTolerance(a, b)))
  )
  if (sameValue) return pieces.some((piece) => matchesPiece(grader, input, piece)) // one number, many forms

  // Different numbers: the answer is the whole set, in any order.
  const given = splitList(input, grader).map((piece) => numberCandidates(piece, grader.numeric))
  if (given.length !== pieces.length || given.some((candidates) => candidates === null)) return false
  return pairsUp(given as number[][], all, grader)
}

// -- multiple choice --------------------------------------------------------------------------

const legacyNormalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^\$+|\$+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/, '')
    .trim()

const OPTION_LETTER = /^\(?([a-h])[).:]?(?:\s|$)/i

/** "B" and "b)" and "B. O(V + E)" all name option B. */
function optionLetter(value: string): string | null {
  const match = OPTION_LETTER.exec(value.trim())
  return match ? match[1].toLowerCase() : null
}

function checkMultipleChoice(step: PracticeCheckStep, input: string): boolean {
  const given = legacyNormalize(input)
  if (!given) return false
  const targets = [step.correctAnswer, ...step.acceptableAnswers]
  if (targets.some((target) => legacyNormalize(target) === given)) return true
  const letter = optionLetter(input)
  // Only a bare letter or "B) text" counts, and the key has to name a letter the same way.
  return letter ? targets.some((target) => optionLetter(target) === letter) : false
}

export function checkPracticeAnswer(step: PracticeCheckStep, input: string): boolean {
  if (step.answerType === 'multiple_choice') return checkMultipleChoice(step, input)

  const given = cleanAnswer(input)
  if (!given) return false
  const tolerance = typeof step.tolerance === 'number' && Number.isFinite(step.tolerance) && step.tolerance >= 0
  const grader: Grader = {
    numeric: step.answerType === 'numeric',
    tolerance: tolerance ? (step.tolerance as number) : null,
  }
  return [step.correctAnswer, ...step.acceptableAnswers].some((target) => {
    const wanted = cleanAnswer(target)
    return wanted !== '' && matchesTarget(grader, given, wanted)
  })
}

const OPTION_LINE = /^\s*(?:[-*]\s*)?\(?([A-H])[).:]\s+(.+?)\s*$/

/**
 * Practice steps of type multiple_choice carry no options field; a model usually writes them as
 * lines such as "A) O(V)" in the question. Returns the question without those lines and the
 * options, or null when there are fewer than two (then the step is answered as text).
 */
export function splitChoices(question: string): { stem: string; options: { id: string; text: string }[] } | null {
  const lines = question.split('\n')
  const options: { id: string; text: string }[] = []
  const stem: string[] = []
  for (const line of lines) {
    const match = OPTION_LINE.exec(line)
    if (match) options.push({ id: match[1].toUpperCase(), text: match[2] })
    else stem.push(line)
  }
  if (options.length < 2) return null
  return { stem: stem.join('\n').trim(), options }
}

/**
 * Why a wrong answer was wrong, when the form of it says so without confirming any part of the answer: a
 * numeric step whose key is a number, answered with something that is not a number. Nothing about the size,
 * sign or digits is ever said (a note on those would tell the student their digits are right). Null otherwise.
 */
export function missNote(step: PracticeCheckStep, input: string): string | null {
  if (step.answerType !== 'numeric' || !cleanAnswer(input)) return null
  if (parseNumber(step.correctAnswer) === null) return null
  return parseNumber(input) === null ? 'Your answer should be a number. A unit after it is fine.' : null
}
