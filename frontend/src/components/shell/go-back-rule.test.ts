import { describe, expect, it } from 'vitest'
import { canGoBackInApp } from './go-back-rule'

describe('canGoBackInApp', () => {
  it('is false with no earlier entry', () => {
    expect(canGoBackInApp(1, 'https://app.test/home', 'https://app.test', true)).toBe(false)
  })
  it('is true after an in-app navigation', () => {
    expect(canGoBackInApp(3, '', 'https://app.test', true)).toBe(true)
  })
  it('is true for a same-site referrer', () => {
    expect(canGoBackInApp(2, 'https://app.test/courses/1', 'https://app.test', false)).toBe(true)
  })
  it('is false for another site or none', () => {
    expect(canGoBackInApp(2, 'https://elsewhere.test/', 'https://app.test', false)).toBe(false)
    expect(canGoBackInApp(2, '', 'https://app.test', false)).toBe(false)
  })
})
