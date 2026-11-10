import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Checks, outcomeOf } from './checks'

const EXPECTED = {
  'WF9.blank-mastery': { fixedBy: 'SW11', finding: '38' },
  'WF9.never-run': { fixedBy: 'G1', finding: '79' },
  'WF8.other': { fixedBy: 'F2', finding: '78' },
}

describe('workflow checks', () => {
  it('classifies a check by whether it passed and whether it is listed as failing today', () => {
    assert.equal(outcomeOf(true, false), 'pass')
    assert.equal(outcomeOf(false, false), 'fail')
    assert.equal(outcomeOf(false, true), 'expected-fail')
    assert.equal(outcomeOf(true, true), 'unexpected-pass')
  })

  it('keeps going after a failed check and reports only new failures and fixed-but-listed checks as problems', async () => {
    const checks = new Checks('WF9', EXPECTED)
    assert.equal(await checks.check('WF9.ok', 'a passing check', () => undefined), true)
    const blank = await checks.check('WF9.blank-mastery', 'blanks leave mastery alone', async () => {
      throw new Error('mastery moved 7% to 28%')
    })
    assert.equal(blank, false)
    const fresh = await checks.check('WF9.new', 'a new failure', () => {
      throw new Error('boom\nCall log: noise')
    })
    assert.equal(fresh, false)
    assert.equal(await checks.check('WF9.never-run', 'fixed already', () => undefined), true)

    assert.deepEqual(
      checks.problems().map((r) => [r.id, r.outcome]),
      [
        ['WF9.new', 'fail'],
        ['WF9.never-run', 'unexpected-pass'],
      ]
    )
    assert.deepEqual(checks.counts(), { pass: 1, 'expected-fail': 1, fail: 1, 'unexpected-pass': 1 })
    const listed = checks.results.find((r) => r.id === 'WF9.blank-mastery')
    assert.deepEqual([listed?.fixedBy, listed?.finding, listed?.error], ['SW11', '38', 'mastery moved 7% to 28%'])
    assert.equal(checks.results.find((r) => r.id === 'WF9.new')?.error, 'boom | Call log: noise')
  })

  it("names the listed checks of this workflow that never ran, and no other workflow's", async () => {
    const checks = new Checks('WF9', EXPECTED)
    await checks.check('WF9.blank-mastery', 'blanks leave mastery alone', () => {
      throw new Error('moved')
    })
    assert.deepEqual(checks.notRun(), ['WF9.never-run'])
    assert.match(checks.report(), /MISS WF9\.never-run/)
  })

  it('refuses a check id from another workflow or one used twice', async () => {
    const checks = new Checks('WF9', EXPECTED)
    await assert.rejects(checks.check('WF8.other', 'not mine', () => undefined), /does not belong to WF9/)
    await checks.check('WF9.ok', 'once', () => undefined)
    await assert.rejects(checks.check('WF9.ok', 'twice', () => undefined), /ran twice/)
  })
})
