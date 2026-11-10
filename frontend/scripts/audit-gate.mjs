// Fails when `npm audit --omit=dev` reports a high or critical advisory that is not listed below with a reason.
// `npm audit --audit-level=high` cannot skip one advisory, so the CI step runs this instead.
import { spawnSync } from 'node:child_process'

/** Advisory id -> why it is accepted. Remove an entry when the reason stops being true. */
const ACCEPTED = {
  'GHSA-mrhx-c7xc-m3w5':
    'zod before 4.6.6: memory use while validating a huge array in the zod 4 parser. This app is on zod 3 (3.25), ' +
    'which does not have that code, and every request body is cut off at a byte cap (src/lib/api/read-json.ts) before ' +
    'it is parsed. The fix is the zod 4 major, which needs its own migration (checked 2026-11-10).',
}

const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
let report
try {
  report = JSON.parse(run.stdout)
} catch {
  console.error('npm audit gave no readable report')
  process.exit(1)
}

const found = []
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue
  const advisories = (vuln.via ?? []).filter((via) => typeof via === 'object')
  if (advisories.length === 0) {
    found.push(`${name}: ${vuln.severity} through a dependency`)
    continue
  }
  for (const advisory of advisories) {
    const id = String(advisory.url ?? '').split('/').pop()
    if (id in ACCEPTED) {
      console.log(`accepted ${id} (${name}): ${ACCEPTED[id]}`)
    } else {
      found.push(`${name}: ${advisory.title} (${advisory.url})`)
    }
  }
}

if (found.length > 0) {
  console.error(`High or critical advisories:\n${found.join('\n')}`)
  process.exit(1)
}
console.log('npm audit: no high or critical advisories beyond the accepted ones')
