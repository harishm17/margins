import type { Expected } from './harness/checks'

/**
 * Checks that fail on today's app, each with the plan item that fixes it and the walkthrough finding it shows
 * (IMPLEMENTATION-PLAN.md and FINDINGS.md in the walkthrough notes). A PR that fixes one turns its check green
 * and removes its line here: a listed check that passes fails the workflow, so a fix cannot quietly regress.
 */
export const EXPECTED_FAILURES: Readonly<Record<string, Expected>> = {
  // WF1, a new course
  'WF1.upload-status-not-cut-off': { fixedBy: 'SW6', finding: '43' }, // "Getting your pages ready for study and search, step 3 of 3" ends in an ellipsis
  'WF1.file-order': { fixedBy: 'F6', finding: '4' }, // newest first: quiz-1, scan, lecture-3, lecture-2, lecture-1
  'WF1.one-rename-pattern': { fixedBy: 'U6', finding: '44' }, // a "Rename" button under every topic
}
