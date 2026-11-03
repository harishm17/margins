import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mathToWords, speakable } from './speakable'

describe('speakable: powers', () => {
  it('says squared and cubed', () => {
    assert.equal(speakable('The area is $x^2$.'), 'The area is x squared.')
    assert.equal(speakable('The volume is $r^3$ times pi.'), 'The volume is r cubed times pi.')
  })

  it('says other powers with "to the"', () => {
    assert.equal(speakable('It grows like $2^n$.'), 'It grows like 2 to the n.')
    assert.equal(speakable('$x^{n+1}$'), 'x to the power of n plus 1')
    assert.equal(speakable('$e^{-x}$'), 'e to the negative x')
    assert.equal(speakable('$e^-x$'), 'e to the negative x')
  })

  it('says the quantity for a bracket that is raised', () => {
    assert.equal(speakable('$(a+b)^2$'), 'the quantity a plus b squared')
  })

  it('handles a caret outside dollar signs', () => {
    assert.equal(speakable('Then x^2 grows faster than x.'), 'Then x squared grows faster than x.')
    assert.equal(speakable('Think of 2^10.'), 'Think of 2 to the 10.')
  })
})

describe('speakable: fractions and roots', () => {
  it('says simple fractions as over', () => {
    assert.equal(speakable('$\\frac{1}{2}$'), '1 over 2')
    assert.equal(speakable('The slope is $\\frac{dy}{dx}$.'), 'The slope is d y over d x.')
  })

  it('names a fraction with a longer top or bottom', () => {
    assert.equal(speakable('$\\frac{x+1}{x-1}$'), 'the fraction x plus 1 over x minus 1')
  })

  it('says square, cube and nth roots', () => {
    assert.equal(speakable('$\\sqrt{x}$'), 'the square root of x')
    assert.equal(speakable('$\\sqrt[3]{8}$'), 'the cube root of 8')
    assert.equal(speakable('$\\sqrt[n]{x}$'), 'the nth root of x')
    assert.equal(speakable('$\\sqrt{x^2+y^2}$ is the distance.'), 'the square root of x squared plus y squared, is the distance.')
  })
})

describe('speakable: subscripts, Greek and operators', () => {
  it('says sub', () => {
    assert.equal(speakable('Take $x_i$ and $a_{n+1}$.'), 'Take x sub i and a sub n plus 1.')
    assert.equal(speakable('$x_1^2$'), 'x sub 1 squared')
  })

  it('names Greek letters, as commands and as characters', () => {
    assert.equal(speakable('$\\alpha + \\beta$'), 'alpha plus beta')
    assert.equal(speakable('The angle θ and the mean μ.'), 'The angle theta and the mean mu.')
    assert.equal(speakable('The circle has area $\\pi r^2$.'), 'The circle has area pi r squared.')
    assert.equal(speakable('Area = πr²'), 'Area equals pi r squared')
  })

  it('says the operators', () => {
    assert.equal(speakable('$a = b$'), 'a equals b')
    assert.equal(speakable('$a \\neq b$, $a \\leq b$, $a \\geq b$'), 'a does not equal b, a less than or equal to b, a greater than or equal to b')
    assert.equal(speakable('$a \\pm b$ and $a \\times b$ and $a \\div b$'), 'a plus or minus b and a times b and a divided by b')
    assert.equal(speakable('a ≠ b, a ≤ b, a ≥ b, a ± b, a × b, a ÷ b'), 'a does not equal b, a less than or equal to b, a greater than or equal to b, a plus or minus b, a times b, a divided by b')
    assert.equal(speakable('$a/b$'), 'a over b')
    assert.equal(speakable('$\\cdot$'), 'times')
  })

  it('tells a sign from a subtraction', () => {
    assert.equal(speakable('$-5$'), 'negative 5')
    assert.equal(speakable('$3 - 2$'), '3 minus 2')
    assert.equal(speakable('$x = -1$'), 'x equals negative 1')
    assert.equal(speakable('$2 \\cdot -3$'), '2 times negative 3')
  })

  it('reads text inside math and drops spacing commands', () => {
    assert.equal(speakable('$\\text{speed} = \\frac{d}{t}$'), 'speed equals d over t')
    assert.equal(speakable('$a\\,b$'), 'a b')
    assert.equal(speakable('$\\left( x + 1 \\right)$'), 'x plus 1')
  })

  it('says sums, limits and infinity', () => {
    assert.equal(speakable('$\\lim_{x \\to \\infty} f(x)$'), 'the limit sub x goes to infinity f x')
  })
})

describe('speakable: percent, money and slashes', () => {
  it('says percent', () => {
    assert.equal(speakable('About 50% of them.'), 'About 50 percent of them.')
    assert.equal(speakable('A 12.5 % rate.'), 'A 12.5 percent rate.')
    assert.equal(speakable('$\\%$'), 'percent')
  })

  it('keeps money out of math', () => {
    assert.equal(speakable('It costs $5 and then $10.'), 'It costs 5 dollars and then 10 dollars.')
    assert.equal(speakable('It costs $5.50.'), 'It costs 5.50 dollars.')
  })

  it('says a slash by what it is', () => {
    assert.equal(speakable('The ratio is 3/4.'), 'The ratio is 3 over 4.')
    assert.equal(speakable('Use x/y here.'), 'Use x over y here.')
    assert.equal(speakable('Use and/or.'), 'Use and or.')
    assert.equal(speakable('TCP/IP is a stack.'), 'TCP slash IP is a stack.')
    assert.equal(speakable('On 10/11/2026 we met.'), 'On 10/11/2026 we met.')
  })

  it('says equals and comparisons in plain text', () => {
    assert.equal(speakable('So x = 5.'), 'So x equals 5.')
    assert.equal(speakable('If n > 3 then stop.'), 'If n greater than 3 then stop.')
    assert.equal(speakable('Then 2 + 3 is five.'), 'Then 2 plus 3 is five.')
  })

  it('says pi', () => {
    assert.equal(speakable('π is about 3.14.'), 'pi is about 3.14.')
  })
})

describe('speakable: leaves ordinary text alone', () => {
  it('returns plain sentences as they are', () => {
    for (const text of ['A hash function maps keys to buckets.', "Don't worry, it's fine.", 'C++ is fast, and so is Rust.', 'See pages 3-5.']) {
      assert.equal(speakable(text), text)
    }
  })

  it('handles empty input and an unclosed dollar sign', () => {
    assert.equal(speakable(''), '')
    assert.equal(speakable('That costs $'), 'That costs $')
  })

  it('does not change the text it was given', () => {
    const text = 'Use $x^2$ here.'
    speakable(text)
    assert.equal(text, 'Use $x^2$ here.')
  })

  it('handles display and bracket delimiters', () => {
    assert.equal(speakable('\\(x^2\\)'), 'x squared')
    assert.equal(speakable('\\[\\frac{a}{b}\\]'), 'a over b')
    assert.equal(speakable('$$E = mc^2$$'), 'E equals m c squared')
  })
})

describe('mathToWords', () => {
  it('splits variables but keeps short words together', () => {
    assert.equal(mathToWords('2xy'), '2 x y')
    assert.equal(mathToWords('\\sin x'), 'sine x')
    assert.equal(mathToWords('n!'), 'n factorial')
  })
})
