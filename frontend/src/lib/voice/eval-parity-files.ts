/** Where the teach-back eval keeps its scenarios and the fixtures the parity test compares (see eval-parity.ts). */

import fs from 'node:fs'
import path from 'node:path'
import { ideasOf, teachParityFixture, teachPromptFixture, utteranceFixture, type TeachScenario } from './eval-parity'

export { ideasOf, teachParityFixture, teachPromptFixture, utteranceFixture }

const evalDir = path.resolve(process.cwd(), '..', 'evals', 'tutoring')
export const TEACH_SCENARIOS = path.join(evalDir, 'scenarios', 'teach-back-original.jsonl')
export const TEACH_STATE_FIXTURE = path.join(evalDir, 'fixtures', 'teach_state_parity.json')
/** The same replay with PROMPTS_V2 naming voice: the tags, the confront example and the example check's name differ. */
export const TEACH_STATE_FIXTURE_V2 = path.join(evalDir, 'fixtures', 'teach_state_parity_v2.json')
export const UTTERANCE_FIXTURE = path.join(evalDir, 'fixtures', 'utterance_parity.json')
export const TEACH_PROMPT_FIXTURE = path.join(evalDir, 'fixtures', 'teach_back_prompts.json')
/** The same for the audited (PROMPTS_V2, area voice) prompts; the eval uses it when it runs in v2 mode. */
export const TEACH_PROMPT_FIXTURE_V2 = path.join(evalDir, 'fixtures', 'teach_back_prompts_v2.json')

export const loadTeachScenarios = (file: string): TeachScenario[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TeachScenario)
