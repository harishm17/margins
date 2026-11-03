/**
 * Writes evals/tutoring/fixtures/teach_state_parity.json (the real assessment logic played over the eval's committed
 * scenarios) and teach_back_prompts.json (the coach's prompt and tools), from src/lib/voice/eval-parity.ts. Run it after
 * the teach-back logic, the coach prompt or the scenarios change, from frontend/:
 *
 *   npx tsx scripts/teach-parity-fixture.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  TEACH_PROMPT_FIXTURE,
  TEACH_SCENARIOS,
  TEACH_STATE_FIXTURE,
  UTTERANCE_FIXTURE,
  loadTeachScenarios,
  teachParityFixture,
  teachPromptFixture,
  utteranceFixture,
} from '../src/lib/voice/eval-parity-files'

const scenarios = loadTeachScenarios(TEACH_SCENARIOS)
fs.mkdirSync(path.dirname(TEACH_STATE_FIXTURE), { recursive: true })
fs.writeFileSync(TEACH_STATE_FIXTURE, JSON.stringify(teachParityFixture(scenarios), null, 1) + '\n')
fs.writeFileSync(TEACH_PROMPT_FIXTURE, JSON.stringify(teachPromptFixture(scenarios), null, 1) + '\n')
fs.writeFileSync(UTTERANCE_FIXTURE, JSON.stringify(utteranceFixture(scenarios), null, 1) + '\n')
console.log(`Wrote ${TEACH_STATE_FIXTURE}, ${TEACH_PROMPT_FIXTURE} and ${UTTERANCE_FIXTURE}: ${scenarios.length} scenarios`)
