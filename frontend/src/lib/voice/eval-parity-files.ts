/** Where the teach-back eval keeps its scenarios and the fixtures the parity test compares (see eval-parity.ts). */

import fs from 'node:fs'
import path from 'node:path'
import { teachParityFixture, teachPromptFixture, utteranceFixture, type TeachScenario } from './eval-parity'

export { teachParityFixture, teachPromptFixture, utteranceFixture }

const evalDir = path.resolve(process.cwd(), '..', 'evals', 'tutoring')
export const TEACH_SCENARIOS = path.join(evalDir, 'scenarios', 'teach-back-original.jsonl')
export const TEACH_STATE_FIXTURE = path.join(evalDir, 'fixtures', 'teach_state_parity.json')
export const UTTERANCE_FIXTURE = path.join(evalDir, 'fixtures', 'utterance_parity.json')
export const TEACH_PROMPT_FIXTURE = path.join(evalDir, 'fixtures', 'teach_back_prompts.json')

export const loadTeachScenarios = (file: string): TeachScenario[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TeachScenario)
