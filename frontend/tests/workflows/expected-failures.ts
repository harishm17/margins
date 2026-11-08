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
  // WF4, mock exam
  'WF4.form-up-to': { fixedBy: 'U10', finding: '26' }, // "10 questions": nothing says the exam may hold fewer
  'WF4.form-plain-words': { fixedBy: 'C4', finding: '23' }, // "the wording, task verbs and answer length of the exams you uploaded"
  'WF4.build-header': { fixedBy: 'SW7', finding: '25' }, // "New mock exam / Choose what to cover..." stays while the exam is written
  'WF4.build-wait-estimate': { fixedBy: 'SW7', finding: '25' }, // "This takes a few minutes"
  'WF4.exam-order': { fixedBy: 'U8', finding: '28' }, // topics interleaved and out of course order, a choice question after a written one
  'WF4.flag-second-browser': { fixedBy: 'SW10', finding: '30' }, // flags live in the first browser's session storage
  'WF4.position-second-browser': { fixedBy: 'SW10', finding: '31' }, // a second browser opens the exam on question 1
  'WF4.unstudied-folded': { fixedBy: 'SW16', finding: '36' }, // one "Not answered" row per never-opened topic
  'WF4.jump-to-missed': { fixedBy: 'U9', finding: '37' }, // no "Next missed" or "Next not answered"
  'WF4.results-rendered': { fixedBy: 'SW2', finding: '32' }, // a question row's preview strips "$" and shows the LaTeX ("\log")
  'WF4.one-exam-name': { fixedBy: 'U7', finding: '22, 39' }, // the tab titles say "Mock exam", "Taking a mock exam", "Mock exam results"
  // WF5, Ask
  'WF5.tagline-guides': { fixedBy: 'E5', finding: '9' }, // "Answers come only from your files, with sources."
  'WF5.concept-sentences': { fixedBy: 'SW3', finding: '2, 48' }, // "about <idea>" in the intro, "explain <idea>" and "about <idea>" in the suggestions
  // WF6, voice
  'WF6.one-verdict': { fixedBy: 'V2', finding: '69' }, // the evaluation row repeats the coach's words under the chip
  'WF6.next-button': { fixedBy: 'V1', finding: '68' }, // the coach asks whether the student is ready; only a typed "yes" moves on
  'WF6.summary-one-action': { fixedBy: 'R1', finding: '84' }, // "Practice this" filled, "Start again" and the back link outlined
  'WF6.revisit-in-full': { fixedBy: 'R1', finding: '84' }, // the question to revisit is clipped and has no answer
  'WF6.idle-not-counted': { fixedBy: 'V4', finding: '71' }, // wall time counts while the open tab sends heartbeats
  'WF6.start-here-instead': { fixedBy: 'V4', finding: '71' }, // "Another voice practice looks open", with no way to take over
  'WF6.round-size-stated': { fixedBy: 'V5', finding: '83' }, // "Up to 12 questions" for a round that has none
  'WF6.round-can-start': { fixedBy: 'G1', finding: '83' }, // the round's weakest topics are never-opened ones with no quiz, so Start is disabled
  'WF6.unended-closed': { fixedBy: 'V5', finding: '85' }, // the dead tab's session stays active
  'WF6.drill-keeps-set': { fixedBy: 'V5', finding: '81' }, // Quiz me reads only the newest set: 4 questions before Fix it now, 2 after
}
