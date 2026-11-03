import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isDoneShortcut, type ShortcutTarget } from './shortcuts'

const el = (tagName: string, extra: Partial<NonNullable<ShortcutTarget>> & { role?: string } = {}): ShortcutTarget => ({
  tagName,
  isContentEditable: extra.isContentEditable,
  getAttribute: (name) => (name === 'role' ? (extra.role ?? null) : null),
})

describe('isDoneShortcut', () => {
  it('Enter ends the turn when the page itself has the focus', () => {
    assert.equal(isDoneShortcut({ key: 'Enter' }, el('BODY')), true)
    assert.equal(isDoneShortcut({ key: 'Enter' }, null), true)
    assert.equal(isDoneShortcut({ key: 'Enter' }, el('DIV')), true)
  })

  it('never fires while typing in a text field', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      assert.equal(isDoneShortcut({ key: 'Enter' }, el(tag)), false, tag)
      assert.equal(isDoneShortcut({ key: 'Enter', ctrlKey: true }, el(tag)), false, tag)
    }
    assert.equal(isDoneShortcut({ key: 'Enter' }, el('DIV', { isContentEditable: true })), false)
    assert.equal(isDoneShortcut({ key: 'Enter', metaKey: true }, el('DIV', { role: 'textbox' })), false)
  })

  it('leaves Enter to a focused button, link or radio card', () => {
    assert.equal(isDoneShortcut({ key: 'Enter' }, el('BUTTON')), false)
    assert.equal(isDoneShortcut({ key: 'Enter' }, el('A')), false)
    assert.equal(isDoneShortcut({ key: 'Enter' }, el('BUTTON', { role: 'radio' })), false)
    assert.equal(isDoneShortcut({ key: 'Enter' }, el('DIV', { role: 'button' })), false)
  })

  it('Ctrl or Cmd with Enter works from a button too', () => {
    assert.equal(isDoneShortcut({ key: 'Enter', ctrlKey: true }, el('BUTTON')), true)
    assert.equal(isDoneShortcut({ key: 'Enter', metaKey: true }, el('BUTTON')), true)
  })

  it('ignores other keys, repeats, Alt and IME composition', () => {
    assert.equal(isDoneShortcut({ key: ' ' }, el('BODY')), false)
    assert.equal(isDoneShortcut({ key: 'Enter', repeat: true }, el('BODY')), false)
    assert.equal(isDoneShortcut({ key: 'Enter', altKey: true }, el('BODY')), false)
    assert.equal(isDoneShortcut({ key: 'Enter', isComposing: true }, el('BODY')), false)
    assert.equal(isDoneShortcut({ key: 'Enter', shiftKey: true }, el('BODY')), false)
  })
})
