/**
 * Writes evals/tutoring/fixtures/app_state_parity.json: the tutor's real logic played over the
 * eval's committed scenarios (src/lib/tutor/eval-parity.ts). Run it after the tutor logic or the
 * scenarios change, from frontend/:
 *
 *   npx tsx scripts/tutoring-parity-fixture.ts
 *
 * With two arguments it plays another scenario file into another output file, to check the locally
 * built practice.jsonl (not committed): npx tsx scripts/tutoring-parity-fixture.ts in.jsonl out.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadScenarios, parityFixture, PARITY_FIXTURE, PARITY_SCENARIOS } from '../src/lib/tutor/eval-parity-files'

const input = process.argv[2] ? path.resolve(process.argv[2]) : PARITY_SCENARIOS
const output = process.argv[3] ? path.resolve(process.argv[3]) : PARITY_FIXTURE
const scenarios = loadScenarios(input)
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify(parityFixture(scenarios), null, 1) + '\n')
console.log(`Wrote ${output}: ${scenarios.length} scenarios`)
