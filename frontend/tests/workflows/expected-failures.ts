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
  // WF2, the first topic
  'WF2.warm-up.no-percent-yet': { fixedBy: 'SW11', finding: '49' }, // "Learning 0%" on the header, sidebar and overview after three warm-up answers
  'WF2.reading.same-next-step': { fixedBy: 'G5', finding: '11' }, // the plan ticks "Learn <topic>" done after warm-up and reading; the topic says Recall
  'WF2.reading.no-percent-yet': { fixedBy: 'SW11', finding: '49' },
  'WF2.recall.same-next-step': { fixedBy: 'SW9, G5', finding: '10, 11' }, // list "Next: Read that part again", path "Recall (next up) 2/5", plan ticked done
  'WF2.recall-check-kept': { fixedBy: 'SW10', finding: '96' }, // the first prompt comes back empty with "Check my answer"
  'WF2.recall.no-percent-yet': { fixedBy: 'SW11', finding: '49' }, // "Learning 16%" after one written recall and one "I don't remember"
  'WF2.quiz.same-next-step': { fixedBy: 'SW9', finding: '10' }, // after the quiz: list "Next: Read that part again", path "Recall (next up) 2/5"
  'WF2.maths-renders': { fixedBy: 'SW2', finding: '93' }, // Examples: a block at the start of the line ends the numbered list, items 3 and 4 run together
  'WF2.concept-sentences': { fixedBy: 'SW3', finding: '2' }, // "Re-read <idea>" under a worked example, "missed <idea>" on Examples
  'WF2.choice-check-reason': { fixedBy: 'SW1', finding: '95' }, // "Type an answer first." beside radio buttons
  'WF2.no-blank-busy-button': { fixedBy: 'SW1', finding: '6' }, // sign-in, create course, confirm topics, start, warm-up next, show the source, save note
  // WF3, review and drill
  'WF3.weakest-are-studied': { fixedBy: 'G1', finding: '83' }, // voice practice's three weakest topics are all topics the student never opened
  'WF3.focus-mix-ups-once': { fixedBy: 'G7', finding: '82' }, // one answer's mix-up is shown under several ideas of the focus
  'WF3.fix-it-now-wait-estimate': { fixedBy: 'SW7', finding: '80' }, // "Preparing your questions" and a bar, no time
  'WF3.position-second-browser': { fixedBy: 'SW10', finding: '30, 31' }, // a second browser opens the review on the next question, not the feedback
  'WF3.follow-up-wait-estimate': { fixedBy: 'SW7', finding: '53' }, // "This takes a moment" while a fresh question is written
  'WF3.retests-as-announced': { fixedBy: 'S4', finding: '97' }, // the header announced "(+5 to retest)"; three retests came
  'WF3.review-end-one-action': { fixedBy: 'R1', finding: '55' }, // a filled button and an outlined one
  'WF3.drill-end-one-action': { fixedBy: 'R1', finding: '55' }, // a filled button and two outlined ones
  'WF3.practice-confidence': { fixedBy: 'Q3', finding: '88' }, // a practice step's answer options have no "How sure are you?" row
}
