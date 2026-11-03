/**
 * The keyboard shortcut for Done (spec 19.2). Pure, so the rule about text fields can be tested.
 *
 * Enter ends the turn when nothing that uses Enter has the focus; Ctrl or Cmd with Enter works
 * from a button too. Neither fires while the student types in a field or while an IME is composing.
 */

export type ShortcutKey = {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
}

export type ShortcutTarget = {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
} | null

const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const ENTER_USERS = new Set(['BUTTON', 'A', 'SUMMARY'])
const ENTER_ROLES = new Set(['button', 'link', 'radio', 'checkbox', 'switch', 'tab', 'menuitem', 'option', 'combobox', 'textbox', 'slider'])

export function isTypingTarget(target: ShortcutTarget): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  const role = target.getAttribute?.('role') ?? null
  if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return true
  return FIELDS.has((target.tagName ?? '').toUpperCase())
}

/** True when this key press should end the student's turn now. */
export function isDoneShortcut(event: ShortcutKey, target: ShortcutTarget): boolean {
  if (event.key !== 'Enter' || event.repeat || event.isComposing || event.altKey) return false
  if (isTypingTarget(target)) return false
  const modified = !!(event.ctrlKey || event.metaKey)
  if (!modified && event.shiftKey) return false
  if (modified) return true
  // Plain Enter keeps its job on a button, a link or a radio card.
  const role = target?.getAttribute?.('role') ?? null
  if (target && (ENTER_USERS.has((target.tagName ?? '').toUpperCase()) || (role !== null && ENTER_ROLES.has(role)))) return false
  return true
}
