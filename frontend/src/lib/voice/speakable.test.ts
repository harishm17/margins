import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { speakable } from './speakable'

describe('speakable: powers', () => {
  it('says squared and cubed', () => {
    assert.equal(speakable('The area is $x^2$.'), 'The area is x squared.')
    assert.equal(speakable('The volume is $r^3$ times pi.'), 'The volume is r cubed times pi.')
  })

})

describe('speakable: fractions and roots', () => {
  it('says simple fractions as over', () => {
    assert.equal(speakable('$\\frac{1}{2}$'), '1 over 2')
    assert.equal(speakable('The slope is $\\frac{dy}{dx}$.'), 'The slope is d y over d x.')
  })

})

describe('speakable: subscripts, Greek and operators', () => {

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

})

describe('speakable: percent, money and slashes', () => {

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

})

describe('speakable: leaves ordinary text alone', () => {

  it('handles empty input and an unclosed dollar sign', () => {
    assert.equal(speakable(''), '')
    assert.equal(speakable('That costs $'), 'That costs $')
  })

})
