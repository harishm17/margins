import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDraftKey, validateDraftPayload } from './draft-contract'
import { explainerCheckKey, parseExplainerCheckDraft } from './explainer-check-draft'

test('a block key is a valid explainer_check key that follows the question, not the spacing', () => {
  const key = explainerCheckKey('topic-1', 'gap-claim_9', 'What does a hash table do?')
  assert.ok(key)
  assert.ok(parseDraftKey('explainer_check', key))
  assert.ok(key.startsWith('topic-1:gap-claim_9-'))
  assert.equal(explainerCheckKey('topic-1', 'gap-claim_9', '  What does a   hash table do? '), key)
  assert.notEqual(explainerCheckKey('topic-1', 'gap-claim_9', 'Another question?'), key)
  assert.notEqual(explainerCheckKey('topic-1', 'notes', 'What does a hash table do?'), key)
})

test('a stored draft is read only when it holds some text, and the payload passes the contract', () => {
  assert.deepEqual(parseExplainerCheckDraft({ answer: 'chaining' }), { answer: 'chaining' })
  assert.equal(parseExplainerCheckDraft({ answer: '' }), null)
  assert.equal(parseExplainerCheckDraft({ answer: 3 }), null)
  assert.equal(parseExplainerCheckDraft(null), null)
  assert.equal(validateDraftPayload('explainer_check', { answer: 'chaining' }).ok, true)
})
