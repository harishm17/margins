import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import config from '../../../playwright.config'

// Playwright loads every file it matches, and node:test files run as they are loaded: a workflow harness test that
// changes process.env (outage.test.ts sets E2E_RUN_DIR) then changes it for the e2e workers started after it, and
// their hold gates land where the stack never looks.
describe('the Playwright run', () => {
  it('loads the e2e specs only, never the workflow tests', () => {
    const root = path.resolve(__dirname, '../../..')
    assert.equal(path.resolve(root, config.testDir ?? '.'), path.join(root, 'tests', 'e2e'))
  })
})

describe('an environment variable a test sets for a moment', () => {
  it('is unset again afterwards when it was unset before', async () => {
    const { withEnv } = await import('./env')
    delete process.env.WF_ENV_PROBE
    withEnv('WF_ENV_PROBE', 'x', () => assert.equal(process.env.WF_ENV_PROBE, 'x'))
    assert.equal('WF_ENV_PROBE' in process.env, false)
  })

  it('is put back as it was when it was set', async () => {
    const { withEnv } = await import('./env')
    process.env.WF_ENV_PROBE = 'before'
    withEnv('WF_ENV_PROBE', 'x', () => undefined)
    assert.equal(process.env.WF_ENV_PROBE, 'before')
    delete process.env.WF_ENV_PROBE
  })
})
