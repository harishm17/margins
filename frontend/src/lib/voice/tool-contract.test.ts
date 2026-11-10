import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { COACH_STYLES } from './coach-prompt'
import { TOOL_RESULT_KEYS, type V2ToolName } from './tool-results'
import { toolsForStyle } from './tools'

// Prompt audit 2026-11-09: the v1 assess_explanation description left out an action the code returns
// (explain_first). The coach only knows a tool's results from its description, so every action the
// teach-back tools can return must be named there.
describe('voice tool contract', () => {
  it('the v2 assess_explanation description names every action teach-tools.ts returns', () => {
    const source = readFileSync(join(__dirname, 'teach-tools.ts'), 'utf8')
    const actions = new Set([...source.matchAll(/action: '([a-z_]+)'/g)].map((match) => match[1]))
    assert.ok(actions.size >= 5, `expected the teach-back actions, found ${[...actions].join(', ')}`)
    const tool = toolsForStyle('teach_back', true).find((candidate) => candidate.name === 'assess_explanation')
    assert.ok(tool, 'assess_explanation is a teach-back tool')
    const missing = [...actions].filter((action) => !new RegExp(`\\b${action}\\b`).test(tool.description))
    assert.deepEqual(missing, [])
  })

  // R6: the keys come from the typed results (tool-results.ts), which the handlers are built against.
  describe('v2 tools, every style', () => {
    const REASONING = /^(analysis|reasoning|thinking|scratchpad|chain_of_thought|trace)$/i
    for (const style of COACH_STYLES) {
      const tools = toolsForStyle(style, true)

      it(`${style}: no two tools share a name, and no input asks for reasoning`, () => {
        assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length)
        for (const tool of tools) {
          const asked = Object.keys(tool.input_schema.properties).filter((key) => REASONING.test(key))
          assert.deepEqual(asked, [], tool.name)
        }
      })

      for (const tool of tools) {
        it(`${style}: ${tool.name} names every key of its result`, () => {
          const keys = TOOL_RESULT_KEYS[tool.name as V2ToolName]
          assert.ok(keys, `${tool.name} has no typed result in tool-results.ts`)
          const missing = keys.filter((key) => !new RegExp(`\\b${key}\\b`).test(tool.description))
          assert.deepEqual(missing, [])
        })

        it(`${style}: ${tool.name} asks for no value the server holds`, () => {
          const held = Object.keys(tool.input_schema.properties).filter((key) => ['question_index', 'concept_id', 'claim_index'].includes(key))
          assert.deepEqual(held, [])
        })
      }
    }

    it('the two checks have names of their own', () => {
      assert.ok(toolsForStyle('teach_back', true).some((tool) => tool.name === 'record_example_check'))
      assert.ok(toolsForStyle('guided_reading', true).some((tool) => tool.name === 'record_claim_check'))
      assert.ok(![...COACH_STYLES].some((style) => toolsForStyle(style, true).some((tool) => tool.name === 'record_check')))
    })
  })
})
