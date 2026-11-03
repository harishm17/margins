/** Where the Ask eval keeps its scenarios and the fixture the parity test compares (see eval-parity.ts). */

import fs from 'node:fs'
import path from 'node:path'
import { askParityFixture, type AskScenario } from './eval-parity'

export { askParityFixture }

const evalDir = path.resolve(process.cwd(), '..', 'evals', 'tutoring')
export const ASK_PARITY_SCENARIOS = path.join(evalDir, 'scenarios', 'ask-original.jsonl')
export const ASK_PARITY_FIXTURE = path.join(evalDir, 'fixtures', 'ask_state_parity.json')

export const loadAskScenarios = (file: string): AskScenario[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AskScenario)
