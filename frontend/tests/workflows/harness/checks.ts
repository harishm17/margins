/**
 * The workflow suite's checks. A workflow is a list of steps (navigation, clicks, waits: if one fails the
 * workflow cannot go on, so it fails at once, as any Playwright step does) and checks (observations about
 * the state the steps left: each is recorded and the workflow goes on).
 *
 * A check that fails on today's app is listed in expected-failures.ts with the plan item that fixes it.
 * The workflow fails when a check fails that is not listed, when a listed check passes (the fix landed:
 * remove its line, so it stays fixed), or when a listed check did not run (its id changed).
 */

export type Outcome = 'pass' | 'expected-fail' | 'unexpected-pass' | 'fail'

/** Why a check is expected to fail today: the plan item that fixes it and the finding it shows. */
export type Expected = { fixedBy: string; finding: string }

export type CheckResult = {
  id: string
  what: string
  outcome: Outcome
  fixedBy?: string
  finding?: string
  error?: string
}

export function outcomeOf(passed: boolean, expected: boolean): Outcome {
  if (expected) return passed ? 'unexpected-pass' : 'expected-fail'
  return passed ? 'pass' : 'fail'
}

const firstLines = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error)
  // Playwright's messages carry ANSI colours, and a call log after the first lines.
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '')
  return plain
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 4)
    .join(' | ')
    .slice(0, 600)
}

export class Checks {
  readonly results: CheckResult[] = []

  constructor(
    readonly workflow: string,
    private readonly expected: Readonly<Record<string, Expected>>
  ) {}

  /** Runs one check. Returns whether it passed, so a later step can depend on it. */
  async check(id: string, what: string, run: () => unknown): Promise<boolean> {
    if (!id.startsWith(`${this.workflow}.`)) throw new Error(`check ${id} does not belong to ${this.workflow}`)
    if (this.results.some((result) => result.id === id)) throw new Error(`check ${id} ran twice: give each run its own id`)
    let error: string | undefined
    try {
      await run()
    } catch (caught) {
      error = firstLines(caught)
    }
    const expected = this.expected[id]
    this.results.push({
      id,
      what,
      outcome: outcomeOf(error === undefined, expected !== undefined),
      ...expected,
      ...(error === undefined ? {} : { error }),
    })
    return error === undefined
  }

  /** Checks that fail the workflow: new failures, and listed failures that now pass. */
  problems(): CheckResult[] {
    return this.results.filter((result) => result.outcome === 'fail' || result.outcome === 'unexpected-pass')
  }

  /** Listed failures of this workflow that never ran. */
  notRun(): string[] {
    const ran = new Set(this.results.map((result) => result.id))
    return Object.keys(this.expected).filter((id) => id.startsWith(`${this.workflow}.`) && !ran.has(id))
  }

  counts(): Record<Outcome, number> {
    const counts: Record<Outcome, number> = { pass: 0, 'expected-fail': 0, 'unexpected-pass': 0, fail: 0 }
    for (const result of this.results) counts[result.outcome] += 1
    return counts
  }

  report(): string {
    const marks: Record<Outcome, string> = { pass: 'ok  ', 'expected-fail': 'xf  ', 'unexpected-pass': 'XP  ', fail: 'FAIL' }
    const lines = this.results.map((result) => {
      const plan = result.fixedBy ? ` [${result.fixedBy}, finding ${result.finding}]` : ''
      const error = result.error ? `\n        ${result.error}` : ''
      return `  ${marks[result.outcome]} ${result.id}: ${result.what}${plan}${error}`
    })
    for (const id of this.notRun()) lines.push(`  MISS ${id}: listed as an expected failure but did not run`)
    const counts = this.counts()
    const head = `${this.workflow}: ${counts.pass} pass, ${counts['expected-fail']} expected failures, ${counts.fail} failures, ${counts['unexpected-pass']} unexpected passes`
    return [head, ...lines].join('\n')
  }
}
