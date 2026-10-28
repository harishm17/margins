import test from 'node:test'
import assert from 'node:assert/strict'
import { scrollToSection, sectionFromHash, sectionHref, shouldScrollInPage, type ClickLike, type ScrollEnv } from './in-page'

const plain: ClickLike = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }
const landing = { pathname: '/' }

test('a plain primary click on the landing page scrolls in the page', () => {
  assert.equal(shouldScrollInPage(plain, landing), true)
  assert.equal(shouldScrollInPage(plain, { pathname: '/', target: '_self' }), true)
})

test('modifier keys and other buttons keep the browser behaviour (new tab, new window, download)', () => {
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
    assert.equal(shouldScrollInPage({ ...plain, [key]: true }, landing), false, key)
  }
  assert.equal(shouldScrollInPage({ ...plain, button: 1 }, landing), false, 'middle click')
  assert.equal(shouldScrollInPage({ ...plain, button: 2 }, landing), false, 'right click')
})

test('a link that opens elsewhere, or a click already handled, is left alone', () => {
  assert.equal(shouldScrollInPage(plain, { pathname: '/', target: '_blank' }), false)
  assert.equal(shouldScrollInPage({ ...plain, defaultPrevented: true }, landing), false)
})

test('on another page the link navigates to the landing page instead', () => {
  assert.equal(shouldScrollInPage(plain, { pathname: '/privacy' }), false)
  assert.equal(shouldScrollInPage(plain, { pathname: null }), false)
})

test('links point at the landing page, and only known sections are read back from a hash', () => {
  assert.equal(sectionHref('trust'), '/#trust')
  assert.equal(sectionFromHash('#faq'), 'faq')
  assert.equal(sectionFromHash('how-it-works'), 'how-it-works')
  assert.equal(sectionFromHash('#main'), null)
  assert.equal(sectionFromHash(''), null)
})

function fakePage({ reduced = false, present = true } = {}) {
  const calls: { scroll: ScrollIntoViewOptions[]; focus: (FocusOptions | undefined)[]; selector: string[] } = { scroll: [], focus: [], selector: [] }
  const env: ScrollEnv = {
    prefersReducedMotion: () => reduced,
    getElementById: (id) =>
      present && id === 'faq'
        ? {
            scrollIntoView: (options) => calls.scroll.push(options),
            querySelector: (selector) => {
              calls.selector.push(selector)
              return { focus: (options) => calls.focus.push(options) }
            },
          }
        : null,
  }
  return { env, calls }
}

test('scrolling is smooth, focuses the heading without a second scroll', () => {
  const { env, calls } = fakePage()
  assert.equal(scrollToSection('faq', env), true)
  assert.deepEqual(calls.scroll, [{ behavior: 'smooth', block: 'start' }])
  assert.deepEqual(calls.selector, ['[data-section-heading]'])
  assert.deepEqual(calls.focus, [{ preventScroll: true }])
})

test('scrolling is instant with reduced motion, or when asked (arriving from another page)', () => {
  const reduced = fakePage({ reduced: true })
  scrollToSection('faq', reduced.env)
  assert.equal(reduced.calls.scroll[0].behavior, 'auto')
  const arrival = fakePage()
  scrollToSection('faq', arrival.env, { instant: true })
  assert.equal(arrival.calls.scroll[0].behavior, 'auto')
})

test('a section that is not on the page reports false, so the link navigates normally', () => {
  const { env, calls } = fakePage({ present: false })
  assert.equal(scrollToSection('faq', env), false)
  assert.equal(calls.scroll.length, 0)
})
