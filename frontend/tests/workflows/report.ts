/**
 * Prints the workflow suite's checks from the results folder: each workflow's counts, the expected failures
 * grouped by the plan item that fixes them, and every problem. Exits 1 when there is a problem.
 *
 *   npx tsx tests/workflows/report.ts [RESULTS_DIR]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CheckResult, Outcome } from './harness/checks'

type Record_ = { workflow: string; title: string; status: string; counts: Record<Outcome, number>; notRun: string[]; results: CheckResult[] }

const dir = process.argv[2] || process.env.WF_RESULTS_DIR || path.join(process.cwd(), 'test-results', 'workflows')
const files = existsSync(dir) ? readdirSync(dir).filter((name) => /^WF\d+\.json$/.test(name)) : []
const records = files
  .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record_)
  .sort((a, b) => Number(a.workflow.slice(2)) - Number(b.workflow.slice(2)))

const lines: string[] = ['', `Workflow checks (${dir})`]
const totals: Record<Outcome, number> = { pass: 0, 'expected-fail': 0, 'unexpected-pass': 0, fail: 0 }
const problems: string[] = []
const byPlanItem = new Map<string, string[]>()

for (const record of records) {
  const c = record.counts
  lines.push(`  ${record.workflow.padEnd(5)} ${record.status.padEnd(8)} ${c.pass} pass, ${c['expected-fail']} expected failures, ${c.fail} failures, ${c['unexpected-pass']} unexpected passes`)
  for (const outcome of Object.keys(totals) as Outcome[]) totals[outcome] += c[outcome]
  if (record.status !== 'passed') problems.push(`${record.workflow}: a step failed (${record.status}); see the Playwright output`)
  for (const result of record.results) {
    if (result.outcome === 'fail') problems.push(`${result.id} failed: ${result.error}`)
    if (result.outcome === 'unexpected-pass') problems.push(`${result.id} passes now: remove it from expected-failures.ts`)
    if (result.outcome === 'expected-fail' && result.fixedBy) {
      const list = byPlanItem.get(result.fixedBy) ?? []
      list.push(`${result.id} (finding ${result.finding})`)
      byPlanItem.set(result.fixedBy, list)
    }
  }
  for (const id of record.notRun) problems.push(`${id} is listed in expected-failures.ts but did not run`)
}

if (records.length === 0) problems.push(`no workflow results in ${dir}`)
lines.push(`  total ${totals.pass} pass, ${totals['expected-fail']} expected failures, ${totals.fail} failures, ${totals['unexpected-pass']} unexpected passes`)
if (byPlanItem.size > 0) {
  lines.push('', 'Expected failures, by the plan item that fixes them:')
  for (const [item, ids] of [...byPlanItem].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) lines.push(`  ${item}: ${ids.join(', ')}`)
}
lines.push('', problems.length === 0 ? 'No problems.' : `Problems (${problems.length}):`, ...problems.map((problem) => `  ${problem}`))
console.log(lines.join('\n'))
process.exit(problems.length === 0 ? 0 : 1)
