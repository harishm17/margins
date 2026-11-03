/**
 * Turns a sentence of the coach's reply into words a speech synthesizer says well (spec 19.6):
 * LaTeX and inline math, powers, fractions, roots, subscripts, Greek letters, operators, percentages.
 *
 * Only the text sent to `speechSynthesis` goes through here. The transcript and the board keep the
 * original notation. Pure and synchronous, so it is tested in node.
 */

/**
 * Math the way the app writes it: `$$..$$`, `\(..\)`, `\[..\]` and `$..$`. A `$` that opens money
 * ("$5 and $10") never matches: inline math may not start or end on a space, and may not be
 * followed by a digit after its closing `$`.
 */
export const MATH_SPAN = /\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$(?!\d)/g

const GREEK = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi',
  'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
])

/** LaTeX commands that are said as these words. */
const COMMAND_WORDS: Record<string, string> = {
  cdot: 'times', times: 'times', ast: 'times', div: 'divided by', pm: 'plus or minus', mp: 'minus or plus',
  leq: 'less than or equal to', le: 'less than or equal to', geq: 'greater than or equal to', ge: 'greater than or equal to',
  neq: 'does not equal', ne: 'does not equal', approx: 'is approximately', equiv: 'is equivalent to', sim: 'is about',
  propto: 'is proportional to', to: 'goes to', rightarrow: 'goes to', longrightarrow: 'goes to', Rightarrow: 'implies',
  leftrightarrow: 'if and only if', Leftrightarrow: 'if and only if', infty: 'infinity', in: 'is in', notin: 'is not in',
  subset: 'is a subset of', cup: 'union', cap: 'intersection', forall: 'for all', exists: 'there exists',
  sum: 'the sum', prod: 'the product', int: 'the integral', lim: 'the limit', partial: 'partial', nabla: 'del',
  ldots: 'and so on', dots: 'and so on', cdots: 'and so on', sin: 'sine', cos: 'cosine', tan: 'tangent', log: 'log',
  ln: 'natural log', exp: 'exp', max: 'max', min: 'min', mod: 'mod', gcd: 'gcd', lcm: 'lcm', det: 'determinant',
  circ: 'degrees', degree: 'degrees', neg: 'not', land: 'and', lor: 'or', ell: 'l', hbar: 'h bar', prime: 'prime',
}

/** Commands whose braces hold plain words: the words are said and nothing is added. */
const WRAPPERS = new Set([
  'text', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mathbb', 'mathcal', 'mathsf', 'boldsymbol', 'operatorname',
  'mbox', 'bf', 'rm', 'overline', 'bar', 'hat', 'vec', 'tilde', 'underline',
])

/** Characters said as words wherever they appear. */
const SYMBOL_WORDS: Record<string, string> = {
  '=': 'equals', '≠': 'does not equal', '≤': 'less than or equal to', '≥': 'greater than or equal to', '≈': 'is approximately',
  '±': 'plus or minus', '∓': 'minus or plus', '×': 'times', '÷': 'divided by', '·': 'times', '⋅': 'times', '∗': 'times',
  '√': 'the square root of', '∛': 'the cube root of', '∞': 'infinity', '→': 'goes to', '⇒': 'implies', '⇔': 'if and only if',
  '∈': 'is in', '∉': 'is not in', '⊂': 'is a subset of', '∪': 'union', '∩': 'intersection', '∀': 'for all', '∃': 'there exists',
  '∑': 'the sum', '∏': 'the product', '∫': 'the integral', '∂': 'partial', '∇': 'del', '°': 'degrees', '′': 'prime',
  '²': 'squared', '³': 'cubed', '½': 'one half', '¼': 'one quarter', '¾': 'three quarters', '−': 'minus', '–': '',
  '%': 'percent', '‰': 'per mille', '∝': 'is proportional to',
}

const GREEK_LETTERS: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa',
  λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi',
  χ: 'chi', ψ: 'psi', ω: 'omega', Γ: 'gamma', Δ: 'delta', Θ: 'theta', Λ: 'lambda', Ξ: 'xi', Π: 'pi', Σ: 'sigma',
  Φ: 'phi', Ψ: 'psi', Ω: 'omega',
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c)
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)

/** The index just past the group that opens at `open` (`{`, `(`, `[`), or -1 when it never closes. */
function closeOf(s: string, open: number): number {
  const opener = s[open]
  const closer = opener === '{' ? '}' : opener === '(' ? ')' : ']'
  let depth = 0
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '\\') {
      i += 1
      continue
    }
    if (s[i] === opener) depth += 1
    else if (s[i] === closer) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** The next argument of a command: a `{group}`, a command, a number or one character. */
function readArg(s: string, from: number): { raw: string; next: number } {
  let i = from
  while (isSpace(s[i])) i += 1
  if (i >= s.length) return { raw: '', next: i }
  if (s[i] === '{') {
    const end = closeOf(s, i)
    if (end < 0) return { raw: s.slice(i + 1), next: s.length }
    return { raw: s.slice(i + 1, end - 1), next: end }
  }
  const start = i
  if (s[i] === '-' || s[i] === '−' || s[i] === '+') i += 1
  if (s[i] === '\\') {
    i += 1
    if (isLetter(s[i])) while (isLetter(s[i])) i += 1
    else i += 1
  } else if (isDigit(s[i])) {
    while (isDigit(s[i]) || (s[i] === '.' && isDigit(s[i + 1]))) i += 1
  } else if (i < s.length) {
    i += 1
  }
  return { raw: s.slice(start, i), next: i }
}

/** More than one term: an operator is spoken inside it, so the listener needs to hear where it begins and ends. */
const isCompound = (words: string) => /\b(plus|minus|times|divided|over|equals|plus or minus)\b/.test(words)

function power(exponent: string): string {
  const words = exponent.trim()
  if (words === '2') return 'squared'
  if (words === '3') return 'cubed'
  if (!words) return ''
  return isCompound(words) ? `to the power of ${words},` : `to the ${words}`
}

/** LaTeX (or plain math with unicode symbols) to spoken words. */
export function mathToWords(source: string): string {
  const s = source
  const out: string[] = []
  // True where an operand may start: a minus there is a sign, not a subtraction.
  let operandNext = true
  let i = 0

  const word = (w: string, startsOperand = false) => {
    if (w) out.push(w)
    operandNext = startsOperand
  }

  while (i < s.length) {
    const c = s[i]
    if (isSpace(c)) {
      i += 1
      continue
    }

    if (c === '\\') {
      const nameMatch = /^[A-Za-z]+/.exec(s.slice(i + 1))
      if (!nameMatch) {
        // \, \; \! \  \\ \% \$ \{ \}
        const escaped = s[i + 1]
        i += 2
        if (escaped === '%') word('percent')
        else if (escaped === '$') word('dollars')
        else if (escaped === '{' || escaped === '}' || escaped === ',' || escaped === ';' || escaped === '!' || escaped === ' ' || escaped === '\\' || escaped === undefined) continue
        else word(escaped)
        continue
      }
      const name = nameMatch[0]
      i += 1 + name.length
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const a = readArg(s, i)
        const b = readArg(s, a.next)
        i = b.next
        const top = mathToWords(a.raw)
        const bottom = mathToWords(b.raw)
        word(isCompound(top) || isCompound(bottom) ? `the fraction ${top} over ${bottom},` : `${top} over ${bottom}`)
      } else if (name === 'sqrt') {
        let index = ''
        let j = i
        while (isSpace(s[j])) j += 1
        if (s[j] === '[') {
          const end = closeOf(s, j)
          if (end > 0) {
            index = s.slice(j + 1, end - 1).trim()
            i = end
          }
        }
        const body = readArg(s, i)
        i = body.next
        const inner = mathToWords(body.raw)
        const root = index === '' || index === '2' ? 'square root' : index === '3' ? 'cube root' : `${mathToWords(index)}th root`
        word(`the ${root} of ${inner}${isCompound(inner) ? ',' : ''}`)
      } else if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigg' || name === 'displaystyle' || name === 'limits' || name === 'quad' || name === 'qquad') {
        // Delimiters and spacing: say nothing. A \left( or \right) keeps its bracket for the loop below.
        continue
      } else if (WRAPPERS.has(name)) {
        const body = readArg(s, i)
        i = body.next
        word(mathToWords(body.raw), false)
      } else if (name === 'pi') {
        word('pi')
      } else if (GREEK.has(name)) {
        word(name)
      } else if (name === 'varepsilon') word('epsilon')
      else if (name === 'vartheta') word('theta')
      else if (name === 'varphi') word('phi')
      else if (name === 'Gamma' || name === 'Delta' || name === 'Theta' || name === 'Lambda' || name === 'Xi' || name === 'Pi' || name === 'Sigma' || name === 'Phi' || name === 'Psi' || name === 'Omega') {
        word(name.toLowerCase())
      } else if (name === 'cdot' || name === 'times' || name === 'ast') {
        word('times', true)
      } else if (name in COMMAND_WORDS) {
        const startsOperand = ['pm', 'mp', 'div', 'leq', 'le', 'geq', 'ge', 'neq', 'ne', 'approx', 'equiv', 'sim', 'propto', 'to', 'rightarrow', 'longrightarrow', 'Rightarrow', 'in', 'notin', 'subset', 'cup', 'cap', 'sum', 'prod', 'int', 'lim', 'land', 'lor', 'neg'].includes(name)
        word(COMMAND_WORDS[name], startsOperand)
      } else {
        word(name)
      }
      continue
    }

    if (c === '^' || c === '_') {
      const arg = readArg(s, i + 1)
      i = arg.next
      const inner = mathToWords(arg.raw)
      if (c === '^') word(power(inner))
      else word(inner ? `sub ${inner}` : '')
      continue
    }

    if (c === '{') {
      const end = closeOf(s, i)
      const inner = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end - 1)
      i = end < 0 ? s.length : end
      word(mathToWords(inner), false)
      continue
    }

    if (c === '(') {
      const end = closeOf(s, i)
      const inner = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end - 1)
      const after = end < 0 ? s.length : end
      let k = after
      while (isSpace(s[k])) k += 1
      i = after
      const words = mathToWords(inner)
      // (a + b)^2 is "the quantity a plus b squared"; plain brackets are not spoken.
      word(s[k] === '^' || s[k] === '_' ? `the quantity ${words}` : words, false)
      continue
    }

    if (c === ')' || c === '[' || c === ']' || c === '|') {
      i += 1
      continue
    }

    if (c === '<' || c === '>') {
      const orEqual = s[i + 1] === '='
      i += orEqual ? 2 : 1
      word(`${c === '<' ? 'less' : 'greater'} than${orEqual ? ' or equal to' : ''}`, true)
      continue
    }
    if (c === '=') {
      i += s[i + 1] === '=' ? 2 : 1
      word('equals', true)
      continue
    }
    if (c === '+') {
      i += 1
      word(operandNext ? '' : 'plus', true)
      continue
    }
    if (c === '-' || c === '−' || c === '–') {
      i += 1
      word(operandNext ? 'negative' : 'minus', true)
      continue
    }
    if (c === '*') {
      i += 1
      word('times', true)
      continue
    }
    if (c === '/') {
      i += 1
      word('over', true)
      continue
    }
    if (c === '!') {
      i += 1
      word('factorial')
      continue
    }
    if (c === "'") {
      i += 1
      word('prime')
      continue
    }
    if (c === ',' || c === ';' || c === ':') {
      i += 1
      word(c === ':' ? 'to' : ',', true)
      continue
    }

    if (GREEK_LETTERS[c]) {
      i += 1
      word(GREEK_LETTERS[c])
      continue
    }
    if (c in SYMBOL_WORDS) {
      i += 1
      const symbolWord = SYMBOL_WORDS[c]
      const startsOperand = c !== '²' && c !== '³' && c !== '°' && c !== '%' && c !== '′' && c !== '½' && c !== '¼' && c !== '¾'
      word(symbolWord, startsOperand)
      continue
    }

    if (isDigit(c)) {
      let j = i
      while (isDigit(s[j]) || ((s[j] === '.' || s[j] === ',') && isDigit(s[j + 1]))) j += 1
      word(s.slice(i, j))
      i = j
      continue
    }

    if (isLetter(c)) {
      let j = i
      while (isLetter(s[j])) j += 1
      const run = s.slice(i, j)
      // One or two letters are variables said one by one (xy is "x y"); longer runs are words (sin, max).
      if (run.length <= 2) for (const letter of run) word(letter)
      else word(run)
      i = j
      continue
    }

    i += 1
  }

  return tidy(out.join(' '))
}

/** Text outside delimiters: symbols that are plainly math, percentages, money, slashes, bare powers. */
function plainToWords(text: string): string {
  let out = text
  // Money: "$5" is "5 dollars" (a lone $ before a digit was not math, see MATH_SPAN).
  out = out.replace(/\$(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars')
  // Powers written with a caret: x^2, 2^10, (n+1)^2, e^{-x}.
  out = out.replace(/(?:[A-Za-z0-9]|\))\^(?:\{[^}]*\}|-?[A-Za-z0-9]+)/g, (match) => ` ${mathToWords(match)} `)
  // Slashes: 3/4 is "3 over 4", x/y is "x over y", and/or is "and or", a/b of words is "a slash b".
  out = out.replace(/(?<![\w/.])([A-Za-z0-9]+)\/([A-Za-z0-9]+)(?![\w/])/g, (match, a: string, b: string) => {
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return `${a} over ${b}`
    if (a.length === 1 && b.length === 1) return `${a} over ${b}`
    if (/^and$/i.test(a) && /^or$/i.test(b)) return `${a} ${b}`
    return `${a} slash ${b}`
  })
  // "x = 5", "a ≤ b", "n > 3"; "C++" and "->" are left alone.
  out = out.replace(/\s(<=|>=|==|=|<|>)\s/g, (_m, op: string) => {
    const words: Record<string, string> = { '<=': 'less than or equal to', '>=': 'greater than or equal to', '==': 'equals', '=': 'equals', '<': 'less than', '>': 'greater than' }
    return ` ${words[op]} `
  })
  out = out.replace(/(\d|\))\s*([+])\s*(?=[\d(A-Za-z])/g, '$1 plus ')
  // Single symbols and Greek letters, percentages.
  let spoken = ''
  for (const ch of out) {
    if (GREEK_LETTERS[ch]) spoken += ` ${GREEK_LETTERS[ch]} `
    else if (ch === '²' || ch === '³') spoken += ` ${SYMBOL_WORDS[ch]} `
    else if (ch === '%' ) spoken += ' percent '
    else if (ch !== '−' && ch !== '–' && ch in SYMBOL_WORDS && ch !== '·') spoken += ` ${SYMBOL_WORDS[ch]} `
    else if (ch === '−') spoken += ' minus '
    else spoken += ch
  }
  return spoken
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/,\s*([.!?])/g, "$1")
    .trim()
}

function stripDelimiters(span: string): string {
  if (span.startsWith('$$')) return span.slice(2, -2)
  if (span.startsWith('\\(') || span.startsWith('\\[')) return span.slice(2, -2)
  return span.slice(1, -1)
}

/** The sentence as it should be said. The text on screen is not touched. */
export function speakable(text: string): string {
  if (!text) return ''
  const parts: string[] = []
  let last = 0
  for (const match of text.matchAll(MATH_SPAN)) {
    const index = match.index ?? 0
    parts.push(plainToWords(text.slice(last, index)))
    parts.push(` ${mathToWords(stripDelimiters(match[0]))} `)
    last = index + match[0].length
  }
  parts.push(plainToWords(text.slice(last)))
  return tidy(parts.join('')).replace(/,$/, '')
}
