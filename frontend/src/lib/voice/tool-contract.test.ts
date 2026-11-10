import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
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
})
