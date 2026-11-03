/**
 * Writes evals/tutoring/fixtures/ask_state_parity.json: Ask's real logic played over the eval's committed
 * scenarios (src/lib/ask/eval-parity.ts). Run it after the Ask logic or the scenarios change, from frontend/:
 *
 *   npx tsx scripts/ask-parity-fixture.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { ASK_PARITY_FIXTURE, ASK_PARITY_SCENARIOS, askParityFixture, loadAskScenarios } from '../src/lib/ask/eval-parity-files'

const scenarios = loadAskScenarios(ASK_PARITY_SCENARIOS)
fs.mkdirSync(path.dirname(ASK_PARITY_FIXTURE), { recursive: true })
fs.writeFileSync(ASK_PARITY_FIXTURE, JSON.stringify(askParityFixture(scenarios), null, 1) + '\n')
console.log(`Wrote ${ASK_PARITY_FIXTURE}: ${scenarios.length} scenarios`)
