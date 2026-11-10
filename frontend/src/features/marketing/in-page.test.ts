import test from 'node:test'
import assert from 'node:assert/strict'
import { sectionFromHash, shouldScrollInPage, type ClickLike } from './in-page'

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

test('a fragment that does not decode, or names no section, is ignored instead of throwing', () => {
  for (const hash of ['#50%', '#%E0%A4%A', '#%', '#faq%', '#unknown', '#FAQ']) {
    assert.doesNotThrow(() => sectionFromHash(hash), hash)
    assert.equal(sectionFromHash(hash), null, hash)
  }
  assert.equal(sectionFromHash('#%66aq'), 'faq')
})
