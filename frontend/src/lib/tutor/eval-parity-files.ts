/** Where the tutoring eval keeps the scenarios and the fixture the parity test compares (see eval-parity.ts). */

import fs from 'node:fs'
import path from 'node:path'
import { parityFixture, type Scenario } from './eval-parity'

export { parityFixture }

const evalDir = path.resolve(process.cwd(), '..', 'evals', 'tutoring')
export const PARITY_SCENARIOS = path.join(evalDir, 'scenarios', 'practice-original.jsonl')
export const PARITY_FIXTURE = path.join(evalDir, 'fixtures', 'app_state_parity.json')

export const loadScenarios = (file: string): Scenario[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Scenario)
