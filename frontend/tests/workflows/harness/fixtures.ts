import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test as base } from '@playwright/test'
import { EXPECTED_FAILURES } from '../expected-failures'
import { Checks } from './checks'

/** Where each workflow writes its checks for report.ts. scripts/workflows.sh sets it and clears it before a run. */
export const resultsDir = () => process.env.WF_RESULTS_DIR || path.join(process.cwd(), 'test-results', 'workflows')

/**
 * `test` with a `checks` fixture. A workflow's title starts with its id ("WF2 first topic ..."), which scopes
 * its check ids. After the workflow its checks are written to the results folder and printed; then, if every
 * step passed, any problem in the checks (see checks.ts) fails it.
 */
export const test = base.extend<{ checks: Checks }>({
  checks: async ({}, provide, testInfo) => {
    const workflow = /^(WF\d+)\b/.exec(testInfo.title)?.[1]
    if (!workflow) throw new Error(`A workflow's title starts with its id, like "WF2 ...": "${testInfo.title}"`)
    const checks = new Checks(workflow, EXPECTED_FAILURES)
    await provide(checks)

    const report = checks.report()
    mkdirSync(resultsDir(), { recursive: true })
    const record = { workflow, title: testInfo.title, status: testInfo.status, counts: checks.counts(), notRun: checks.notRun(), results: checks.results }
    writeFileSync(path.join(resultsDir(), `${workflow}.json`), JSON.stringify(record, null, 1))
    await testInfo.attach('checks', { body: report, contentType: 'text/plain' })
    console.log(report)

    if (testInfo.status !== 'passed') return
    const problems = checks.problems().map((result) => `${result.id} (${result.outcome === 'fail' ? 'failed' : 'passes now: remove it from expected-failures.ts'})`)
    problems.push(...checks.notRun().map((id) => `${id} (listed in expected-failures.ts but did not run)`))
    if (problems.length > 0) throw new Error(`${workflow} checks: ${problems.join('; ')}`)
  },
})

export { expect } from '@playwright/test'
