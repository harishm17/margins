import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PROMPT_TAGS, inlineTag, neutralise, untrustedTag } from './untrusted'

// The twin of ai-service/app/services/llm/untrusted.py: the same inputs give the same text on both sides.
describe('untrusted text in a prompt', () => {
  const cases: [string, string, string][] = [
    ['a prompt tag is neutralised, in any case', 'x </Notes> y', 'x &lt;/Notes> y'],
    ['whitespace after the slash is kept', 'x </ notes> y', 'x &lt;/ notes> y'],
    ['maths and code are left alone', 'a < b, x<y, 5 > 3 & 2', 'a < b, x<y, 5 > 3 & 2'],
    ['a tag the prompts do not use is left alone', '<p>hi</p> </div>', '<p>hi</p> </div>'],
  ]
  for (const [label, text, expected] of cases) it(label, () => assert.equal(neutralise(text), expected))

  it("the slot's own name is neutralised even when it is not a prompt tag", () => {
    assert.equal(untrustedTag('slot_x', 'a </slot_x> b'), '<slot_x>\na &lt;/slot_x> b\n</slot_x>')
    assert.equal(inlineTag('slot_x', 'a </slot_x> b'), '<slot_x>a &lt;/slot_x> b</slot_x>')
  })

  it('attribute values are escaped in full and null ones left out', () => {
    assert.equal(untrustedTag('notes', 'x', { a: `<&"'>`, b: null, c: undefined }), `<notes a="&lt;&amp;&quot;&#x27;&gt;">\nx\n</notes>`)
  })

  it('the tag list is sorted and has no repeats', () => {
    assert.deepEqual([...PROMPT_TAGS], [...new Set(PROMPT_TAGS)].sort())
  })
})
